"""GreenUtilityLog — send your meter reading automatically.

Home Assistant already reads the meter (DSMR, HAN, Tibber, an IR head, whatever your
country uses). This integration takes the cumulative-kWh entity you pick and posts it
to GreenUtilityLog on a timer, so you never photograph the meter again.

Deliberately a *service* integration: it creates no devices of its own, it just
forwards a number you already have. The single diagnostic sensor exists so you can see
in the UI whether pushing actually works.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import (
    ATTR_CONFIG_ENTRY_ID,
    CONF_INGEST_URL,
    CONF_INTERVAL,
    CONF_SOURCE_ENTITY,
    CONF_TOKEN,
    DEFAULT_INGEST_URL,
    DEFAULT_INTERVAL_MINUTES,
    DOMAIN,
    FAILED_PUSH_RETRIES,
    FAILED_PUSH_RETRY_MINUTES,
    LOGGER,
    PUSH_RETRY_WAIT_SECONDS,
    PUSH_TIMEOUT_SECONDS,
    PUSH_TRIES,
    SERVICE_PUSH_NOW,
    STALE_AFTER_HOURS,
    UNIT_TO_KWH,
)

# A few Home Assistant helpers are imported inside the functions that use them rather
# than up here: tests/test_logic.py drives the pusher against a minimal stand-in for
# Home Assistant that provides only what this module imports when it loads.

PLATFORMS: list[Platform] = [Platform.SENSOR]


class GreenUtilityLogPusher:
    """Reads the chosen entity and posts its value to the reward backend."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        # Surfaced by the diagnostic sensor so a failure is visible in the UI rather
        # than only in the log.
        self.last_reading: float | None = None
        self.last_success: Any = None
        self.last_error: str | None = None
        self._listeners: list[Callable[[], None]] = []
        self._cancel_retry: Callable[[], None] | None = None
        self._retries_left = 0
        self._stopped = False

    def add_listener(self, cb: Callable[[], None]) -> Callable[[], None]:
        """Subscribe to push results. Returns the unsubscribe callable.

        Without this the diagnostic sensor would only refresh on Home Assistant's
        default 30-second poll, so a failure could sit invisible for half a minute and
        the sensor would still read `unknown` immediately after setup.
        """
        self._listeners.append(cb)

        def _remove() -> None:
            if cb in self._listeners:
                self._listeners.remove(cb)

        return _remove

    def _notify(self) -> None:
        for cb in list(self._listeners):
            try:
                cb()
            except Exception:  # noqa: BLE001 — one bad listener must not stop the rest
                LOGGER.exception("GreenUtilityLog: listener failed")

    def _options(self) -> dict[str, Any]:
        """Options win over the original setup values, so edits take effect."""
        return {**self.entry.data, **self.entry.options}

    async def async_push(self, _now: Any = None) -> None:
        """Read the source entity once and forward it. Never raises."""
        # try/finally rather than a _notify() at each return: the method has six exit
        # paths and a future seventh would silently stop updating the sensor.
        try:
            await self._push_once()
        finally:
            self._notify()

    async def async_timed_push(self, _now: Any = None) -> None:
        """A push from a timer: once Home Assistant has started, then every interval.

        One that fails is tried again FAILED_PUSH_RETRY_MINUTES later instead of a
        whole interval (12 h by default) later. The first push after a restart needs
        that most: the integration that reads the meter may not have its entity up
        yet when ours runs.
        """
        self._retries_left = FAILED_PUSH_RETRIES
        await self._async_push_or_retry()

    async def _async_push_or_retry(self, _now: Any = None) -> None:
        self.async_cancel_retry()
        await self.async_push()
        if self.last_error is None or self._stopped or self._retries_left <= 0:
            return
        minutes = int(self._options().get(CONF_INTERVAL, DEFAULT_INTERVAL_MINUTES))
        if minutes <= FAILED_PUSH_RETRY_MINUTES:
            return  # the next interval comes sooner than a retry would
        self._retries_left -= 1
        from homeassistant.core import HassJob
        from homeassistant.helpers.event import async_call_later

        # cancel_on_shutdown: a retry pending when Home Assistant stops is dropped,
        # not left as a timer that outlives it.
        self._cancel_retry = async_call_later(
            self.hass,
            FAILED_PUSH_RETRY_MINUTES * 60,
            HassJob(self._async_push_or_retry, "GreenUtilityLog retry", cancel_on_shutdown=True),
        )

    @callback
    def async_cancel_retry(self) -> None:
        if self._cancel_retry is not None:
            self._cancel_retry()
            self._cancel_retry = None

    @callback
    def async_stop(self) -> None:
        """On unload: drop a pending retry, and schedule none from a push still running."""
        self._stopped = True
        self.async_cancel_retry()

    async def _push_once(self) -> None:
        opts = self._options()
        entity_id = opts.get(CONF_SOURCE_ENTITY)
        state = self.hass.states.get(entity_id) if entity_id else None

        if state is None:
            self.last_error = f"entity {entity_id} not found"
            LOGGER.warning("GreenUtilityLog: %s", self.last_error)
            return
        if state.state in ("unknown", "unavailable", "", None):
            # Normal during restarts/outages — don't spam the log at warning level.
            self.last_error = f"{entity_id} is {state.state}"
            LOGGER.debug("GreenUtilityLog: %s", self.last_error)
            return

        try:
            reading = float(state.state)
        except (TypeError, ValueError):
            self.last_error = f"{entity_id} is not a number: {state.state!r}"
            LOGGER.warning("GreenUtilityLog: %s", self.last_error)
            return

        # The unit is checked when the sensor is picked, but HA lets anyone switch an
        # energy sensor's display unit later: Wh made every reading 1000x too high
        # (refused as implausible), MWh made it go down (refused as running backwards),
        # and the server's 200 on arrival hid both. Converted here, every time.
        unit = state.attributes.get("unit_of_measurement")
        factor = UNIT_TO_KWH.get(unit) if unit else 1.0
        if factor is None:
            self.last_error = f"{entity_id} is in {unit}, not kWh — pick the meter's kWh total"
            LOGGER.warning("GreenUtilityLog: %s", self.last_error)
            return
        reading = round(reading * factor, 3)

        # 0 (a reader that just restarted), negative, inf or nan is not a meter total;
        # sent anyway it replaced the good reading on the server.
        if not math.isfinite(reading) or reading <= 0:
            self.last_error = f"{entity_id} reports {state.state} — not a meter total, nothing sent"
            LOGGER.warning("GreenUtilityLog: %s", self.last_error)
            return

        # A sensor whose source went quiet (the P1 cable out, the reader offline) keeps
        # its last value, restored even across restarts. Pushed as fresh, it reads as
        # a day without use. last_reported moves on every update, also when the value
        # didn't change, so a quiet night is not mistaken for a dead reader.
        seen = getattr(state, "last_reported", None) or getattr(state, "last_updated", None)
        if seen is not None and dt_util.utcnow() - seen > timedelta(hours=STALE_AFTER_HOURS):
            self.last_error = f"{entity_id} hasn't reported for over {STALE_AFTER_HOURS} hours — is the meter reader online?"
            LOGGER.warning("GreenUtilityLog: %s", self.last_error)
            return

        url = opts.get(CONF_INGEST_URL) or DEFAULT_INGEST_URL
        session = async_get_clientsession(self.hass)
        # The public backend sleeps between pushes (free plan) and takes 30-60 s to
        # wake, and with two pushes a day nearly every push is the one that wakes
        # it. So: 90 s per try, and two more tries for what passes on its own (a
        # timeout, 429, 502-504). A refused token or reading fails at once.
        for attempt in range(1, PUSH_TRIES + 1):
            retry = False
            try:
                async with session.post(
                    url,
                    json={"token": opts[CONF_TOKEN], "reading": reading},
                    timeout=aiohttp.ClientTimeout(total=PUSH_TIMEOUT_SECONDS),
                ) as resp:
                    if resp.status < 400:
                        break
                    body = (await resp.text())[:200]
                    self.last_error = f"server said {resp.status}: {body}"
                    retry = resp.status in (429, 502, 503, 504)
            except Exception as err:  # noqa: BLE001 — a push failure must never break HA
                # str(TimeoutError()) is "", which left the sensor showing no error.
                self.last_error = f"could not reach the server ({str(err) or type(err).__name__})"
                retry = True
            if not retry or attempt == PUSH_TRIES:
                LOGGER.warning("GreenUtilityLog: push failed — %s", self.last_error)
                return
            LOGGER.debug("GreenUtilityLog: %s — trying again (%s/%s)", self.last_error, attempt, PUSH_TRIES)
            await asyncio.sleep(PUSH_RETRY_WAIT_SECONDS)

        self.last_reading = reading
        self.last_success = dt_util.utcnow()
        self.last_error = None
        LOGGER.debug("GreenUtilityLog: pushed %s", reading)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up from a config entry."""
    from homeassistant.helpers.start import async_at_started

    pusher = GreenUtilityLogPusher(hass, entry)
    # hass.data rather than entry.runtime_data: one place for the push_now service
    # to find every entry's pusher.
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = pusher
    entry.async_on_unload(pusher.async_stop)

    minutes = int({**entry.data, **entry.options}.get(CONF_INTERVAL, DEFAULT_INTERVAL_MINUTES))
    entry.async_on_unload(
        async_track_time_interval(hass, pusher.async_timed_push, timedelta(minutes=minutes))
    )
    # Re-load when the user edits options, so a new interval/entity takes effect.
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Push once straight away, so the user sees it work instead of waiting 12 hours.
    # Not during setup itself, though: on a restart this runs before the meter's own
    # integration has its entity up, the push found nothing, and the next try was a
    # whole interval later. So: once Home Assistant has started (at once when it
    # already has, as after adding the integration), with retries if it fails.
    async def _first_push(_hass: HomeAssistant) -> None:
        await pusher.async_timed_push()

    entry.async_on_unload(async_at_started(hass, _first_push))

    # One service for the whole integration, registered by whichever entry comes
    # first and removed with the last. Registering it per entry left the last one's
    # handler in charge: it pushed only that entry, and kept doing so after unload.
    if not hass.services.has_service(DOMAIN, SERVICE_PUSH_NOW):
        hass.services.async_register(DOMAIN, SERVICE_PUSH_NOW, _async_make_push_now(hass))
    return True


def _async_make_push_now(hass: HomeAssistant) -> Callable[[Any], Any]:
    async def _handle_push_now(call: Any) -> None:
        """Send now for every entry, or only the one given as config_entry_id."""
        pushers: dict[str, GreenUtilityLogPusher] = hass.data.get(DOMAIN, {})
        wanted = call.data.get(ATTR_CONFIG_ENTRY_ID)
        if wanted:
            if wanted not in pushers:
                from homeassistant.exceptions import ServiceValidationError

                raise ServiceValidationError(f"No GreenUtilityLog entry with id {wanted}")
            targets = [pushers[wanted]]
        else:
            targets = list(pushers.values())
        # Awaited, so a blocking service call returns once the readings are sent.
        await asyncio.gather(*(p.async_push() for p in targets))

    return _handle_push_now


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        pushers = hass.data.get(DOMAIN, {})
        pushers.pop(entry.entry_id, None)
        if not pushers:
            hass.services.async_remove(DOMAIN, SERVICE_PUSH_NOW)
    return unloaded


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
