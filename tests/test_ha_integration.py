"""Full-stack tests: the integration driven by a real Home Assistant.

These are the ones that prove the parts test_logic.py can't reach — that the config
flow actually produces an entry, that setup wires the timer and the service, that the
diagnostic sensor appears with the right state, and that unloading is clean.

They need pytest-homeassistant-custom-component, which pins a matching Home Assistant
and therefore needs the Python version that HA release supports. When it isn't
installed the whole module skips rather than errors — see the skip guard below. If you
can install it:

    pip install pytest-homeassistant-custom-component
    pytest tests/

Everything in test_logic.py still runs without it.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Skip the module (not error) when the harness isn't available. Must come before the
# homeassistant imports below, since those are what would otherwise fail collection.
pytest.importorskip(
    "pytest_homeassistant_custom_component",
    reason="pytest-homeassistant-custom-component is not installed; "
    "run tests/test_logic.py for the harness-free suite",
)

from homeassistant import config_entries, data_entry_flow  # noqa: E402
from homeassistant.core import HomeAssistant  # noqa: E402
from pytest_homeassistant_custom_component.common import MockConfigEntry  # noqa: E402

from custom_components.greenutilitylog.const import (  # noqa: E402
    CONF_INGEST_URL,
    CONF_INTERVAL,
    CONF_SOURCE_ENTITY,
    CONF_TOKEN,
    DOMAIN,
)

METER = "sensor.meter_total"
INGEST = "https://example.invalid/meter-ingest"

GOOD = {
    CONF_TOKEN: "abc123",
    CONF_SOURCE_ENTITY: METER,
    CONF_INTERVAL: 60,
}
DATA = {**GOOD, CONF_TOKEN: "tok-123", CONF_INGEST_URL: INGEST}


@pytest.fixture(autouse=True)
def _allow_custom_integrations(enable_custom_integrations):
    """Home Assistant refuses to load custom components in tests without this."""
    yield


def _set_meter(
    hass: HomeAssistant,
    state: str,
    unit: str | None = "kWh",
    state_class: str | None = "total_increasing",
) -> None:
    attrs = {}
    if unit:
        attrs["unit_of_measurement"] = unit
    if state_class:
        attrs["state_class"] = state_class
    hass.states.async_set(METER, state, attrs)


def _session(status: int = 200, body: str = "{}", raises: Exception | None = None):
    """A stand-in aiohttp session that records the POST it was given."""
    resp = MagicMock()
    resp.status = status
    resp.text = AsyncMock(return_value=body)
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=resp)
    ctx.__aexit__ = AsyncMock(return_value=False)
    session = MagicMock()
    session.post = MagicMock(side_effect=raises) if raises else MagicMock(return_value=ctx)
    return session


def _pusher(hass: HomeAssistant, entry: MockConfigEntry):
    """Where async_setup_entry stashes the pusher (hass.data, not runtime_data)."""
    return hass.data[DOMAIN][entry.entry_id]


async def _setup(hass: HomeAssistant, session) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, data=DATA, unique_id=METER)
    entry.add_to_hass(hass)
    with patch(
        "custom_components.greenutilitylog.async_get_clientsession", return_value=session
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry


# ── config flow ──────────────────────────────────────────────────────────────

async def test_happy_path_creates_entry(hass: HomeAssistant) -> None:
    _set_meter(hass, "8421.3")
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] == data_entry_flow.FlowResultType.FORM

    with patch("custom_components.greenutilitylog.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_configure(result["flow_id"], GOOD)

    assert result["type"] == data_entry_flow.FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_TOKEN] == "abc123"
    assert result["data"][CONF_SOURCE_ENTITY] == METER
    # The number selector hands back a float; the interval must be stored as an int.
    assert isinstance(result["data"][CONF_INTERVAL], int)


async def test_blank_token_is_rejected(hass: HomeAssistant) -> None:
    _set_meter(hass, "8421.3")
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {**GOOD, CONF_TOKEN: "   "}
    )
    assert result["type"] == data_entry_flow.FlowResultType.FORM
    assert result["errors"][CONF_TOKEN] == "token_required"


async def test_missing_entity_is_rejected(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {**GOOD, CONF_SOURCE_ENTITY: "sensor.does_not_exist"}
    )
    assert result["errors"][CONF_SOURCE_ENTITY] == "entity_not_found"


async def test_non_numeric_entity_is_rejected(hass: HomeAssistant) -> None:
    _set_meter(hass, "unavailable")
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], GOOD)
    assert result["errors"][CONF_SOURCE_ENTITY] == "entity_not_numeric"


async def test_wrong_unit_is_rejected(hass: HomeAssistant) -> None:
    """Picking 'current power' (W) instead of the cumulative total (kWh)."""
    _set_meter(hass, "412", unit="W")
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], GOOD)
    assert result["errors"][CONF_SOURCE_ENTITY] == "entity_not_kwh"


async def test_resetting_kwh_sensor_is_rejected(hass: HomeAssistant) -> None:
    """A kWh sensor that zeroes each billing period (Opower's usage-to-date shape)."""
    _set_meter(hass, "312.5", state_class="total")
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], GOOD)
    assert result["errors"][CONF_SOURCE_ENTITY] == "entity_not_cumulative"


async def test_same_meter_twice_aborts(hass: HomeAssistant) -> None:
    """Two entries for one meter would just double the traffic."""
    _set_meter(hass, "8421.3")
    for expected in (
        data_entry_flow.FlowResultType.CREATE_ENTRY,
        data_entry_flow.FlowResultType.ABORT,
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_USER}
        )
        with patch(
            "custom_components.greenutilitylog.async_setup_entry", return_value=True
        ):
            result = await hass.config_entries.flow.async_configure(result["flow_id"], GOOD)
        assert result["type"] == expected


# ── setup, pushing, sensor ───────────────────────────────────────────────────

async def test_sends_the_reading_with_the_token(hass: HomeAssistant) -> None:
    _set_meter(hass, "8421.3")
    session = _session()
    entry = await _setup(hass, session)

    session.post.assert_called()
    assert session.post.call_args[0][0] == INGEST
    assert session.post.call_args[1]["json"] == {"token": "tok-123", "reading": 8421.3}
    assert _pusher(hass, entry).last_reading == 8421.3
    assert _pusher(hass, entry).last_error is None


async def test_unavailable_meter_sends_nothing(hass: HomeAssistant) -> None:
    """Normal during a restart — skip quietly, don't post a bogus value."""
    _set_meter(hass, "unavailable")
    session = _session()
    entry = await _setup(hass, session)

    session.post.assert_not_called()
    assert _pusher(hass, entry).last_reading is None
    assert "unavailable" in _pusher(hass, entry).last_error


async def test_server_error_is_recorded_not_raised(hass: HomeAssistant) -> None:
    _set_meter(hass, "8421.3")
    session = _session(status=401, body="unknown device token")
    # Setup still succeeds — a rejected push must not break the integration.
    entry = await _setup(hass, session)

    assert _pusher(hass, entry).last_reading is None
    assert "401" in _pusher(hass, entry).last_error


async def test_network_failure_is_recorded_not_raised(hass: HomeAssistant) -> None:
    _set_meter(hass, "8421.3")
    session = _session(raises=OSError("network down"))
    entry = await _setup(hass, session)

    assert _pusher(hass, entry).last_reading is None
    assert "network down" in _pusher(hass, entry).last_error


async def test_diagnostic_sensor_reports_the_last_value(hass: HomeAssistant) -> None:
    _set_meter(hass, "8421.3")
    await _setup(hass, _session())

    state = hass.states.get("sensor.greenutilitylog_last_sent_reading")
    assert state is not None
    assert float(state.state) == 8421.3
    assert state.attributes["source_entity"] == METER


async def test_push_now_service(hass: HomeAssistant) -> None:
    _set_meter(hass, "100.0")
    session = _session()
    entry = await _setup(hass, session)
    calls_before = session.post.call_count

    _set_meter(hass, "101.5")
    with patch(
        "custom_components.greenutilitylog.async_get_clientsession", return_value=session
    ):
        await hass.services.async_call(DOMAIN, "push_now", blocking=True)
        await hass.async_block_till_done()

    assert session.post.call_count > calls_before
    assert _pusher(hass, entry).last_reading == 101.5


async def test_unload_stops_cleanly(hass: HomeAssistant) -> None:
    _set_meter(hass, "8421.3")
    entry = await _setup(hass, _session())
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    # The pusher must be dropped, or a reload would leak one per cycle.
    assert entry.entry_id not in hass.data.get(DOMAIN, {})
