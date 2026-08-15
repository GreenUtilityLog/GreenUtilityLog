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

# Hourly is plenty: the app pays out at most once per cooldown, and a meter total
# barely moves within an hour. The minimum guards against pointless traffic.
DEFAULT_INTERVAL_MINUTES = 60
MIN_INTERVAL_MINUTES = 5
