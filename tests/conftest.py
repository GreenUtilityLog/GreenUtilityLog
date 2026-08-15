"""Test setup.

There are two layers of tests here, and the split is deliberate:

  * test_logic.py — runs ANYWHERE. It stubs the handful of Home Assistant symbols the
    integration imports, so the real logic (validation, the push loop) can be exercised
    with nothing installed but pytest. A test suite that needs an environment nobody
    has is a test suite nobody runs.
  * test_ha_integration.py — the full thing, driving a real Home Assistant. Skipped
    automatically unless pytest-homeassistant-custom-component is installed.

The stubs below are intentionally minimal: just enough shape for the module to import.
They are NOT a Home Assistant emulator, and they can't tell you whether the config flow
renders correctly or whether HACS accepts the repository — only a real install can.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock


def _module(name: str, **attrs) -> types.ModuleType:
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


def _install_homeassistant_stubs() -> None:
    """Put a minimal fake `homeassistant` package in sys.modules.

    Done unconditionally so the logic tests behave identically everywhere, rather than
    passing against a real HA on one machine and a stub on another.
    """

    class _Enum(str):
        """Stand-in for HA's string enums (Platform, UnitOfEnergy, …)."""

    def _passthrough(func=None, **_kw):
        return func if func is not None else (lambda f: f)

    ha = _module("homeassistant")
    ha.__path__ = []  # mark as a package so submodule imports resolve

    _module(
        "homeassistant.config_entries",
        ConfigEntry=type("ConfigEntry", (), {}),
        ConfigFlow=type("ConfigFlow", (), {"__init_subclass__": classmethod(lambda cls, **kw: None)}),
        ConfigFlowResult=dict,
        OptionsFlow=type("OptionsFlow", (), {}),
        SOURCE_USER="user",
    )
    _module(
        "homeassistant.const",
        Platform=types.SimpleNamespace(SENSOR="sensor"),
        UnitOfEnergy=types.SimpleNamespace(KILO_WATT_HOUR="kWh"),
        EntityCategory=types.SimpleNamespace(DIAGNOSTIC="diagnostic"),
    )
    _module(
        "homeassistant.core",
        HomeAssistant=type("HomeAssistant", (), {}),
        callback=_passthrough,
    )

    helpers = _module("homeassistant.helpers")
    helpers.__path__ = []
    _module("homeassistant.helpers.aiohttp_client", async_get_clientsession=lambda hass: MagicMock())
    _module("homeassistant.helpers.event", async_track_time_interval=lambda *a, **kw: (lambda: None))
    _module("homeassistant.helpers.entity_platform", AddEntitiesCallback=object)

    # The selector helpers are only used to describe the config-flow form, so shape
    # doesn't matter here — the validation logic under test never touches them.
    sel = MagicMock()
    sel.TextSelectorType = types.SimpleNamespace(PASSWORD="password")
    sel.NumberSelectorMode = types.SimpleNamespace(BOX="box")
    _module("homeassistant.helpers.selector", **{"__getattr__": lambda n: getattr(sel, n)})
    sys.modules["homeassistant.helpers.selector"] = sel

    util = _module("homeassistant.util")
    util.__path__ = []
    import datetime as _dt

    _module("homeassistant.util.dt", utcnow=lambda: _dt.datetime.now(_dt.timezone.utc))

    components = _module("homeassistant.components")
    components.__path__ = []
    _module(
        "homeassistant.components.sensor",
        SensorEntity=type("SensorEntity", (), {}),
        SensorDeviceClass=types.SimpleNamespace(ENERGY="energy"),
        SensorStateClass=types.SimpleNamespace(TOTAL_INCREASING="total_increasing"),
    )


# Only stub when the real thing isn't importable in a working state. On a machine with
# a healthy Home Assistant install the real modules are used instead.
#
# BaseException, not Exception: a half-installed Home Assistant reaches a broken native
# `cryptography` and dies with pyo3's PanicException, which inherits from BaseException.
# Catching only Exception let that escape and turned every test into a collection error.
try:  # pragma: no cover - depends on the environment
    import homeassistant.config_entries  # noqa: F401
except BaseException:  # noqa: BLE001
    # A failed import can leave partially-initialised `homeassistant.*` modules behind;
    # drop them so the stubs aren't shadowed by broken halves of the real package.
    for _name in [m for m in sys.modules if m == "homeassistant" or m.startswith("homeassistant.")]:
        del sys.modules[_name]
    _install_homeassistant_stubs()
