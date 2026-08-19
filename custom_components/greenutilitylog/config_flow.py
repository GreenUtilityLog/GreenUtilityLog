"""Config flow for GreenUtilityLog.

Three fields, no YAML: paste the device token, pick the entity that holds your
cumulative meter reading, choose how often to send. The entity picker is filtered to
energy sensors, so the list is short even on a busy Home Assistant.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import UnitOfEnergy
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_INGEST_URL,
    CONF_INTERVAL,
    CONF_SOURCE_ENTITY,
    CONF_TOKEN,
    DEFAULT_INGEST_URL,
    DEFAULT_INTERVAL_MINUTES,
    DOMAIN,
    MIN_INTERVAL_MINUTES,
)


def _schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    d = defaults or {}
    return vol.Schema(
        {
            vol.Required(CONF_TOKEN, default=d.get(CONF_TOKEN, "")): selector.TextSelector(
                selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
            ),
            vol.Required(
                CONF_SOURCE_ENTITY, default=d.get(CONF_SOURCE_ENTITY)
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(
                    domain="sensor",
                    device_class="energy",
                )
            ),
            vol.Required(
                CONF_INTERVAL, default=d.get(CONF_INTERVAL, DEFAULT_INTERVAL_MINUTES)
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=MIN_INTERVAL_MINUTES,
                    max=1440,
                    step=5,
                    unit_of_measurement="min",
                    mode=selector.NumberSelectorMode.BOX,
                )
            ),
            vol.Optional(
                CONF_INGEST_URL, default=d.get(CONF_INGEST_URL, DEFAULT_INGEST_URL)
            ): selector.TextSelector(),
        }
    )


def _validate(hass, user_input: dict[str, Any]) -> dict[str, str]:
    """Catch the two mistakes that would otherwise fail silently every hour."""
    errors: dict[str, str] = {}

    if not str(user_input.get(CONF_TOKEN, "")).strip():
        errors[CONF_TOKEN] = "token_required"

    entity_id = user_input.get(CONF_SOURCE_ENTITY)
    state = hass.states.get(entity_id) if entity_id else None
    if state is None:
        errors[CONF_SOURCE_ENTITY] = "entity_not_found"
    else:
        try:
            float(state.state)
        except (TypeError, ValueError):
            # Picking the "current power" sensor instead of the cumulative total is
            # the classic mistake; a non-numeric state is the other.
            errors[CONF_SOURCE_ENTITY] = "entity_not_numeric"
        else:
            unit = state.attributes.get("unit_of_measurement")
            if unit and unit not in (UnitOfEnergy.KILO_WATT_HOUR, "kWh"):
                errors[CONF_SOURCE_ENTITY] = "entity_not_kwh"
            elif state.attributes.get("state_class") in ("total", "measurement"):
                # A kWh sensor that isn't total_increasing is one that RESETS. The
                # trap is Opower (many US utilities): `elec_usage_to_date` is kWh with
                # device_class energy, so it looks right in the picker and passes every
                # other check here — but it zeroes each billing period and can even
                # decrease on a solar account. The backend measures usage as a rise
                # from the last reading, so a monthly reset would read as the meter
                # running backwards and then re-earn the same kWh next cycle.
                errors[CONF_SOURCE_ENTITY] = "entity_not_cumulative"

    return errors


class GreenUtilityLogConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(self.hass, user_input)
            if not errors:
                # One entry per meter entity — adding the same one twice would just
                # double the traffic for no benefit.
                await self.async_set_unique_id(user_input[CONF_SOURCE_ENTITY])
                self._abort_if_unique_id_configured()
                user_input[CONF_INTERVAL] = int(user_input[CONF_INTERVAL])
                return self.async_create_entry(title="GreenUtilityLog", data=user_input)

        return self.async_show_form(
            step_id="user", data_schema=_schema(user_input), errors=errors
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return GreenUtilityLogOptionsFlow()


class GreenUtilityLogOptionsFlow(OptionsFlow):
    """Let the user change the entity, interval or token later."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(self.hass, user_input)
            if not errors:
                user_input[CONF_INTERVAL] = int(user_input[CONF_INTERVAL])
                return self.async_create_entry(data=user_input)

        current = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(
            step_id="init", data_schema=_schema(user_input or current), errors=errors
        )
