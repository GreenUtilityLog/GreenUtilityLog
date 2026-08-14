#!/usr/bin/with-contenv bashio
# Translate the add-on's UI options into the environment the bridge expects, then
# hand over to it. Everything the user would otherwise type in a terminal is a field
# in the add-on's Configuration tab.
set -e

TOKEN="$(bashio::config 'token')"
if [ -z "${TOKEN}" ] || [ "${TOKEN}" = "null" ]; then
  bashio::log.fatal "No device token set. Open the app → Submit → Electricity →"
  bashio::log.fatal "Automatic setup → 'Get my device token', then paste it into"
  bashio::log.fatal "this add-on's Configuration tab and restart."
  bashio::exit.nok
fi

export GUL_TOKEN="${TOKEN}"
export GUL_INGEST_URL="$(bashio::config 'ingest_url')"
export INTERVAL_SEC="$(bashio::config 'interval_sec')"

# Optional fields: only export when actually filled in, so the bridge falls back to
# its own defaults (HomeWizard auto-discovery, field auto-detection) otherwise.
if bashio::config.has_value 'hw_ip'; then export HW_IP="$(bashio::config 'hw_ip')"; fi
if bashio::config.has_value 'read_url'; then export READ_URL="$(bashio::config 'read_url')"; fi
if bashio::config.has_value 'read_field'; then export READ_FIELD="$(bashio::config 'read_field')"; fi

if bashio::config.has_value 'read_url'; then
  bashio::log.info "Reading from ${READ_URL}"
elif bashio::config.has_value 'hw_ip'; then
  bashio::log.info "Reading HomeWizard at ${HW_IP}"
else
  bashio::log.info "Looking for a HomeWizard P1 on the network…"
fi
bashio::log.info "Pushing every $(bashio::config 'interval_sec')s"

exec node /opt/bridge/index.js
