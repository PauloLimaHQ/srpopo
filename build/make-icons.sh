#!/usr/bin/env bash
# Regenerate every app icon from the single source logo (assets/logo.png).
# macOS-only (uses sips + iconutil); run it whenever assets/logo.png changes.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="assets/logo.png"

# 1) Packaged-app + BrowserWindow / Windows icon: 1024px master PNG.
sips -s format png -z 1024 1024 "$SRC" --out build/icon.png >/dev/null

# 2) macOS .icns via a temporary iconset.
ICONSET="build/icon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for sz in 16 32 128 256 512 1024; do
  sips -z "$sz" "$sz" "$SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
done
# Retina (@2x) variants: half-size name, full-size pixels.
sips -z 32   32   "$SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 64   64   "$SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 1024 1024 "$SRC" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o build/icon.icns
rm -rf "$ICONSET"

# 3) Colored menu-bar tray icon (the logo itself, not a monochrome template).
# 18pt fits the ~22px macOS menu bar; @2x is the retina representation.
sips -s format png -z 18 18 "$SRC" --out assets/tray.png    >/dev/null
sips -s format png -z 36 36 "$SRC" --out assets/tray@2x.png >/dev/null

# 4) In-app UI logo, served static from public/ (favicon + header brand mark).
sips -s format png -z 256 256 "$SRC" --out public/logo.png >/dev/null

echo "Icons regenerated from $SRC"
