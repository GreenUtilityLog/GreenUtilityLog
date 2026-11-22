#!/usr/bin/env bash
# What must be in step before anything is published (deploy.yml) — and on every PR
# (server-tests.yml), so a slip shows up before the merge, not as failure mails after.
#   • the add-on's copy of gul.js equals bridge/index.js — compared BEFORE the guide
#     builder runs, since the builder writes that copy itself and a check after it
#     could never fail;
#   • docs/gul.js, docs/guide.html and the add-on copy are what the builder makes;
#   • BRIDGE_VERSION in gul.js equals the add-on's version;
#   • the default server address is the same in the bridge, the app and the
#     Home Assistant integration (the app decides from it whether its setup line
#     needs --ingest).
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "::error::$1"; exit 1; }

cmp -s bridge/index.js ha-addon/gul-bridge/gul.js \
  || fail "ha-addon/gul-bridge/gul.js differs from bridge/index.js — run docs/build_guide.py, commit it and bump the add-on version"
python3 docs/build_guide.py >/dev/null
git diff --quiet -- docs/gul.js docs/guide.html ha-addon/gul-bridge/gul.js \
  || fail "docs/gul.js, docs/guide.html or the add-on copy is out of date — run docs/build_guide.py and commit"
ver="$(sed -n 's/^version: "\(.*\)"/\1/p' ha-addon/gul-bridge/config.yaml)"
grep -q "const BRIDGE_VERSION = \"$ver\";" bridge/index.js \
  || fail "BRIDGE_VERSION in bridge/index.js differs from the add-on version ($ver) in ha-addon/gul-bridge/config.yaml"

bridge="$(sed -n 's/^const DEFAULT_INGEST = "\(.*\)\/meter-ingest";.*/\1/p' bridge/index.js)"
app="$(sed -n 's/^export const BRIDGE_DEFAULT_API = "\(.*\)";.*/\1/p' src/network.js)"
ha="$(sed -n 's/^DEFAULT_INGEST_URL = "\(.*\)\/meter-ingest".*/\1/p' custom_components/greenutilitylog/const.py)"
[ -n "$bridge" ] && [ "$bridge" = "$app" ] && [ "$bridge" = "$ha" ] \
  || fail "the default server differs: bridge '$bridge', app '$app', Home Assistant '$ha'"
echo "release checks ok (add-on $ver, default server $bridge)"
