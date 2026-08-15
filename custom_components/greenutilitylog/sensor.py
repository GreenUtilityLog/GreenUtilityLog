"""A single diagnostic sensor: what was last sent, and did it work.

Without this the integration is invisible — you'd only learn a push failed by reading
the log. The sensor shows the last successfully sent reading; its attributes carry the
timestamp and the last error, so troubleshooting is a glance rather than a log dive.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfEnergy
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_SOURCE_ENTITY, DOMAIN


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities([LastSentSensor(hass, entry)])


class LastSentSensor(SensorEntity):
    """Last meter reading successfully sent to GreenUtilityLog."""

    _attr_has_entity_name = True
    _attr_name = "Last sent reading"
    # The pusher tells us when something changed, so polling would only add latency.
    _attr_should_poll = False
    _attr_icon = "mdi:transmission-tower-export"
    _attr_device_class = SensorDeviceClass.ENERGY
    # TOTAL_INCREASING, not TOTAL: this mirrors a meter register, which only ever
    # counts up (and resets only when the meter itself is replaced).
    _attr_state_class = SensorStateClass.TOTAL_INCREASING
    _attr_native_unit_of_measurement = UnitOfEnergy.KILO_WATT_HOUR
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self._hass = hass
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_last_sent"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "GreenUtilityLog",
            "manufacturer": "GreenUtilityLog",
            "entry_type": "service",
        }

    async def async_added_to_hass(self) -> None:
        """Refresh as soon as a push finishes, rather than on a poll."""
        pusher = self._pusher()
        if pusher is not None:
            self.async_on_remove(pusher.add_listener(self.async_write_ha_state))

    def _pusher(self):
        return self._hass.data.get(DOMAIN, {}).get(self._entry.entry_id)

    @property
    def available(self) -> bool:
        return self._pusher() is not None

    @property
    def native_value(self) -> float | None:
        pusher = self._pusher()
        return pusher.last_reading if pusher else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        pusher = self._pusher()
        if pusher is None:
            return {}
        opts = {**self._entry.data, **self._entry.options}
        return {
            "source_entity": opts.get(CONF_SOURCE_ENTITY),
            "last_sent": pusher.last_success,
            "last_error": pusher.last_error,
        }
