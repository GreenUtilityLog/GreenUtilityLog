#!/usr/bin/env bash
# On a PR: when the add-on's gul.js changes, its version must change too — Home
# Assistant only offers an update when the version does, so without it installed
# add-ons keep the old helper. $1: the base branch to compare with.
set -euo pipefail
cd "$(dirname "$0")/.."
base="${1:?usage: check-addon-bump.sh <base ref>}"
if git diff --quiet "$base" -- ha-addon/gul-bridge/gul.js; then echo "add-on helper unchanged"; exit 0; fi
old="$(git show "$base:ha-addon/gul-bridge/config.yaml" | sed -n 's/^version: "\(.*\)"/\1/p')"
new="$(sed -n 's/^version: "\(.*\)"/\1/p' ha-addon/gul-bridge/config.yaml)"
[ "$old" != "$new" ] || { echo "::error::ha-addon/gul-bridge/gul.js changed but the add-on version is still $new — bump it in ha-addon/gul-bridge/config.yaml (and BRIDGE_VERSION)"; exit 1; }
echo "add-on helper changed, version $old → $new"
