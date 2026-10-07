"""Constants for the GreenUtilityLog integration."""

from logging import Logger, getLogger

LOGGER: Logger = getLogger(__package__)

DOMAIN = "greenutilitylog"

# Config keys
CONF_TOKEN = "token"
CONF_SOURCE_ENTITY = "source_entity"
CONF_INTERVAL = "interval_minutes"
CONF_INGEST_URL = "ingest_url"

# The public reward backend. Only changed by someone running their own instance.
DEFAULT_INGEST_URL = "https://greenutilitylog-rewards.onrender.com/meter-ingest"

# Twelve hours, not one. A reading can only be claimed once per COOLDOWN_MS (20h)
# and /meter-ingest keeps only the newest value, so 23 of 24 hourly pushes are
# discarded. Two a day still leaves a wide margin against the 48h staleness rule,
# and it lets a free-tier backend sleep instead of being woken every hour.
DEFAULT_INTERVAL_MINUTES = 720
MIN_INTERVAL_MINUTES = 5

# A push waits up to 90 s (a sleeping backend takes 30-60 s to wake) and is tried
# three times, 20 s apart, when the failure is one that passes on its own.
PUSH_TIMEOUT_SECONDS = 90
PUSH_TRIES = 3
PUSH_RETRY_WAIT_SECONDS = 20
