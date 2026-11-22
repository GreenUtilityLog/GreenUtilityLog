#!/usr/bin/env bash
# The static files published next to the app (deploy.yml), into the folder given.
# Also run on every PR into a scratch folder, so a renamed or missing file fails
# the PR instead of every Pages deploy after it.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:?usage: pages-assets.sh <dist folder>}"
mkdir -p "$out" "$out/testnet"
# A 404 page inside the site, so a stale address lands somewhere that explains itself.
cp docs/404.html "$out/404.html"
# The guide's og:image.
cp docs/og-image.png "$out/og-image.png"
# Share pages with their own preview cards, and the banners to attach to posts.
cp -r docs/share "$out/share"
cp -r brand/animated/out "$out/media"
# App icon and manifest, for both copies of the app.
for d in "$out" "$out/testnet"; do
  cp brand/logo-256.png "$d/icon.png"
  cp brand/logo-512.png "$d/icon-512.png"
  cp brand/apple-touch-icon.png "$d/apple-touch-icon.png"
  cp docs/manifest.webmanifest "$d/manifest.webmanifest"
done
