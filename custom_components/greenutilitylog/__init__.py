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
    CONF_INGEST_URL,
    CONF_INTERVAL,
    CONF_SOURCE_ENTITY,
    CONF_TOKEN,
    DEFAULT_INGEST_URL,
    DEFAULT_INTERVAL_MINUTES,
    DOMAIN,
    LOGGER,
    PUSH_RETRY_WAIT_SECONDS,
    PUSH_TIMEOUT_SECONDS,
    PUSH_TRIES,
)

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
    pusher = GreenUtilityLogPusher(hass, entry)
    # hass.data rather than entry.runtime_data: runtime_data needs HA 2024.6+, and
    # this pattern works on every version back to well before that. No reason to
    # exclude users running an older Home Assistant for a cosmetic API.
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = pusher

    minutes = int({**entry.data, **entry.options}.get(CONF_INTERVAL, DEFAULT_INTERVAL_MINUTES))
    entry.async_on_unload(
        async_track_time_interval(hass, pusher.async_push, timedelta(minutes=minutes))
    )
    # Re-load when the user edits options, so a new interval/entity takes effect.
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Push once now so the user gets immediate feedback instead of waiting an hour.
    hass.async_create_task(pusher.async_push())

    @callback
    def _handle_push_now(_call: Any) -> None:
        hass.async_create_task(pusher.async_push())

    hass.services.async_register(DOMAIN, "push_now", _handle_push_now)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return unloaded


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
