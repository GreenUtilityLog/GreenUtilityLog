"""Logic tests for the Home Assistant integration.

These deliberately don't spin up a Home Assistant instance. The full HA test harness
(pytest-homeassistant-custom-component) can't be installed everywhere — several of its
dev dependencies don't build on older Pythons — and a test suite nobody can run is
worth nothing. So these drive the two pieces that actually carry risk, against a
minimal stand-in for `hass`:

  * the setup validation, which is what stops a misconfiguration from failing
    silently once an hour, forever;
  * the push loop, which must send the right number and must never raise into HA.

What they do NOT cover: whether HACS accepts the repository, and whether the config
flow renders correctly in the UI. Those need a real install.
"""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from custom_components.greenutilitylog import GreenUtilityLogPusher  # noqa: E402
from custom_components.greenutilitylog.config_flow import _validate  # noqa: E402
from custom_components.greenutilitylog.const import (  # noqa: E402
    CONF_INGEST_URL,
    CONF_INTERVAL,
    CONF_SOURCE_ENTITY,
    CONF_TOKEN,
)

METER = "sensor.meter_total"
INGEST = "https://example.invalid/meter-ingest"


class FakeState:
    def __init__(self, state, unit="kWh", state_class="total_increasing"):
        self.state = state
        self.attributes = {}
        if unit:
            self.attributes["unit_of_measurement"] = unit
        if state_class:
            self.attributes["state_class"] = state_class


class FakeHass:
    """Just enough of `hass` for the code under test: a state lookup."""

    def __init__(self, states: dict[str, FakeState] | None = None):
        self._states = states or {}
        self.states = types.SimpleNamespace(get=self._states.get)


class FakeEntry:
    def __init__(self, data, options=None):
        self.data = data
        self.options = options or {}


def _entry(**over):
    return FakeEntry({
        CONF_TOKEN: "tok-123",
        CONF_SOURCE_ENTITY: METER,
        CONF_INTERVAL: 60,
        CONF_INGEST_URL: INGEST,
        **over,
    })


def _session(status=200, body="{}", raises=None):
    """Stand-in aiohttp session that records the POST it was handed."""
    resp = MagicMock()
    resp.status = status
    resp.text = AsyncMock(return_value=body)
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=resp)
    ctx.__aexit__ = AsyncMock(return_value=False)
    session = MagicMock()
    session.post = MagicMock(side_effect=raises) if raises else MagicMock(return_value=ctx)
    return session


async def _push(hass, entry, session):
    pusher = GreenUtilityLogPusher(hass, entry)
    with patch(
        "custom_components.greenutilitylog.async_get_clientsession", return_value=session
    ):
        await pusher.async_push()
    return pusher


# ── validation ───────────────────────────────────────────────────────────────

def test_valid_setup_has_no_errors():
    hass = FakeHass({METER: FakeState("8421.3")})
    assert _validate(hass, {CONF_TOKEN: "abc", CONF_SOURCE_ENTITY: METER}) == {}


def test_blank_token_is_caught():
    hass = FakeHass({METER: FakeState("8421.3")})
    errors = _validate(hass, {CONF_TOKEN: "   ", CONF_SOURCE_ENTITY: METER})
    assert errors[CONF_TOKEN] == "token_required"


def test_missing_entity_is_caught():
    errors = _validate(FakeHass(), {CONF_TOKEN: "abc", CONF_SOURCE_ENTITY: "sensor.nope"})
    assert errors[CONF_SOURCE_ENTITY] == "entity_not_found"


def test_unavailable_entity_is_caught():
    hass = FakeHass({METER: FakeState("unavailable")})
    errors = _validate(hass, {CONF_TOKEN: "abc", CONF_SOURCE_ENTITY: METER})
    assert errors[CONF_SOURCE_ENTITY] == "entity_not_numeric"


def test_watts_instead_of_kwh_is_caught():
    """The classic mistake: picking 'current power' instead of the meter total."""
    hass = FakeHass({METER: FakeState("412", unit="W")})
    errors = _validate(hass, {CONF_TOKEN: "abc", CONF_SOURCE_ENTITY: METER})
    assert errors[CONF_SOURCE_ENTITY] == "entity_not_kwh"


@pytest.mark.parametrize("state_class", ["total", "measurement"])
def test_resetting_kwh_sensor_is_caught(state_class):
    """Opower's `elec_usage_to_date` shape: kWh, device_class energy — and it zeroes
    every billing period. It passes every other check, so only state_class catches it."""
    hass = FakeHass({METER: FakeState("312.5", state_class=state_class)})
    errors = _validate(hass, {CONF_TOKEN: "abc", CONF_SOURCE_ENTITY: METER})
    assert errors[CONF_SOURCE_ENTITY] == "entity_not_cumulative"


def test_missing_state_class_is_still_accepted():
    """Plenty of good meter sensors set no state_class; don't lock them out."""
    hass = FakeHass({METER: FakeState("8421.3", state_class=None)})
    assert _validate(hass, {CONF_TOKEN: "abc", CONF_SOURCE_ENTITY: METER}) == {}


# ── pushing ──────────────────────────────────────────────────────────────────

def test_sends_reading_and_token_to_the_right_url():
    hass = FakeHass({METER: FakeState("8421.3")})
    session = _session()
    pusher = asyncio.run(_push(hass, _entry(), session))

    assert session.post.call_args[0][0] == INGEST
    assert session.post.call_args[1]["json"] == {"token": "tok-123", "reading": 8421.3}
    assert pusher.last_reading == 8421.3
    assert pusher.last_error is None
    assert pusher.last_success is not None


def test_options_override_the_original_data():
    """Editing options must actually change what gets sent."""
    entry = _entry()
    entry.options = {CONF_TOKEN: "new-token"}
    session = _session()
    asyncio.run(_push(FakeHass({METER: FakeState("100.0")}), entry, session))
    assert session.post.call_args[1]["json"]["token"] == "new-token"


@pytest.mark.parametrize("state", ["unavailable", "unknown", ""])
def test_no_push_when_the_meter_has_no_value(state):
    """Normal during a restart — skip quietly rather than send a bogus number."""
    session = _session()
    pusher = asyncio.run(_push(FakeHass({METER: FakeState(state)}), _entry(), session))
    session.post.assert_not_called()
    assert pusher.last_reading is None


def test_no_push_when_the_entity_is_gone():
    session = _session()
    pusher = asyncio.run(_push(FakeHass(), _entry(), session))
    session.post.assert_not_called()
    assert "not found" in pusher.last_error


def test_non_numeric_state_is_not_sent():
    session = _session()
    pusher = asyncio.run(_push(FakeHass({METER: FakeState("kaput")}), _entry(), session))
    session.post.assert_not_called()
    assert "not a number" in pusher.last_error


def test_server_rejection_is_recorded_not_raised():
    session = _session(status=401, body="unknown device token")
    pusher = asyncio.run(_push(FakeHass({METER: FakeState("8421.3")}), _entry(), session))
    assert pusher.last_reading is None          # a rejected push is not a success
    assert "401" in pusher.last_error
    assert "unknown device token" in pusher.last_error


def test_network_failure_is_recorded_not_raised():
    session = _session(raises=OSError("network down"))
    pusher = asyncio.run(_push(FakeHass({METER: FakeState("8421.3")}), _entry(), session))
    assert pusher.last_reading is None
    assert "network down" in pusher.last_error


# ── notifying the sensor ─────────────────────────────────────────────────────

def test_listener_is_called_on_success_and_on_failure():
    """The diagnostic sensor only stays honest if every push path notifies it."""
    calls = []
    hass = FakeHass({METER: FakeState("8421.3")})
    pusher = GreenUtilityLogPusher(hass, _entry())
    pusher.add_listener(lambda: calls.append(pusher.last_error))

    async def run():
        for session in (_session(), _session(status=500), _session(raises=OSError("down"))):
            with patch(
                "custom_components.greenutilitylog.async_get_clientsession",
                return_value=session,
            ):
                await pusher.async_push()

    asyncio.run(run())
    assert len(calls) == 3
    assert calls[0] is None and calls[1] is not None and calls[2] is not None


def test_listener_is_called_even_when_nothing_is_sent():
    """A meter that went unavailable must show up in the UI, not just stop updating."""
    calls = []
    pusher = GreenUtilityLogPusher(FakeHass({METER: FakeState("unavailable")}), _entry())
    pusher.add_listener(lambda: calls.append(1))
    with patch(
        "custom_components.greenutilitylog.async_get_clientsession", return_value=_session()
    ):
        asyncio.run(pusher.async_push())
    assert calls == [1]


def test_removing_a_listener_stops_the_callbacks():
    """Entities are removed on reload; a leaked listener writes state to a dead entity."""
    calls = []
    pusher = GreenUtilityLogPusher(FakeHass({METER: FakeState("1.0")}), _entry())
    remove = pusher.add_listener(lambda: calls.append(1))
    remove()
    with patch(
        "custom_components.greenutilitylog.async_get_clientsession", return_value=_session()
    ):
        asyncio.run(pusher.async_push())
    assert calls == []


def test_one_broken_listener_does_not_stop_the_others():
    calls = []
    pusher = GreenUtilityLogPusher(FakeHass({METER: FakeState("1.0")}), _entry())
    pusher.add_listener(lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    pusher.add_listener(lambda: calls.append(1))
    with patch(
        "custom_components.greenutilitylog.async_get_clientsession", return_value=_session()
    ):
        asyncio.run(pusher.async_push())
    assert calls == [1]


def test_a_later_success_clears_an_earlier_error():
    hass = FakeHass({METER: FakeState("8421.3")})
    entry = _entry()
    pusher = GreenUtilityLogPusher(hass, entry)

    async def run():
        with patch(
            "custom_components.greenutilitylog.async_get_clientsession",
            return_value=_session(status=500),
        ):
            await pusher.async_push()
        assert pusher.last_error is not None
        with patch(
            "custom_components.greenutilitylog.async_get_clientsession",
            return_value=_session(),
        ):
            await pusher.async_push()

    asyncio.run(run())
    assert pusher.last_error is None
    assert pusher.last_reading == 8421.3
