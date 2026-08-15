"""GreenUtilityLog — send your meter reading automatically.

Home Assistant already reads the meter (DSMR, HAN, Tibber, an IR head, whatever your
country uses). This integration takes the cumulative-kWh entity you pick and posts it
to GreenUtilityLog on a timer, so you never photograph the meter again.

Deliberately a *service* integration: it creates no devices of its own, it just
forwards a number you already have. The single diagnostic sensor exists so you can see
in the UI whether pushing actually works.
"""

from __future__ import annotations

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

    def _options(self) -> dict[str, Any]:
        """Options win over the original setup values, so edits take effect."""
        return {**self.entry.data, **self.entry.options}

    async def async_push(self, _now: Any = None) -> None:
        """Read the source entity once and forward it. Never raises."""
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
        try:
            async with session.post(
                url,
                json={"token": opts[CONF_TOKEN], "reading": reading},
                timeout=aiohttp.ClientTimeout(total=20),
            ) as resp:
                if resp.status >= 400:
                    body = (await resp.text())[:200]
                    self.last_error = f"server said {resp.status}: {body}"
                    LOGGER.warning("GreenUtilityLog: push rejected — %s", self.last_error)
                    return
        except Exception as err:  # noqa: BLE001 — a push failure must never break HA
            self.last_error = str(err)
            LOGGER.warning("GreenUtilityLog: could not reach the server — %s", err)
            return

        self.last_reading = reading
        self.last_success = dt_util.utcnow()
        self.last_error = None
        LOGGER.debug("GreenUtilityLog: pushed %s", reading)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up from a config entry."""
    pusher = GreenUtilityLogPusher(hass, entry)
    entry.runtime_data = pusher

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
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
