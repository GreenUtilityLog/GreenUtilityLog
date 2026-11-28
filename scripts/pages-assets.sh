#!/usr/bin/env bash
# The static files published next to the app (deploy.yml), into the folder given.
# Also run on every PR into a scratch folder, so a renamed or missing file fails
# the PR instead of every Pages deploy after it.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:?usage: pages-assets.sh <dist folder>}"
mkdir -p "$out" "$out/testnet"
# The test copy of the app is gone since the go-live (no testnet server): its old
# address sends people to the app instead of a 404.
cat > "$out/testnet/index.html" <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=/GreenUtilityLog/"><link rel="canonical" href="https://greenutilitylog.github.io/GreenUtilityLog/">
<title>Green Utility Log</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px">
<p>The test version has closed. <a href="/GreenUtilityLog/">Open Green Utility Log →</a></p></body></html>
HTML
# A 404 page inside the site, so a stale address lands somewhere that explains itself.
cp docs/404.html "$out/404.html"
# The guide's og:image.
cp docs/og-image.png "$out/og-image.png"
# Share pages with their own preview cards, and the banners to attach to posts.
cp -r docs/share "$out/share"
cp -r brand/animated/out "$out/media"
# App icon and manifest.
for d in "$out"; do
  cp brand/logo-256.png "$d/icon.png"
  cp brand/logo-512.png "$d/icon-512.png"
  cp brand/apple-touch-icon.png "$d/apple-touch-icon.png"
  cp docs/manifest.webmanifest "$d/manifest.webmanifest"
done
