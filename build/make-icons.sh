#!/usr/bin/env bash
# Regenerate every app icon from the vector masters (assets/logo.svg, the app
# icon; assets/tray.svg, the menu-bar glyph). macOS-only: uses headless Chrome
# to rasterize (it preserves transparency — qlmanage/sips bake an opaque
# background, which would white-out the rounded-icon corners and turn the tray
# template into a solid block), plus sips + iconutil for resizing. Run whenever a
# master changes.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="assets/logo.png"
SVG="assets/logo.svg"
TRAY_SVG="assets/tray.svg"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  echo "error: Google Chrome not found at $CHROME (needed to rasterize SVG with" \
       "transparency)." >&2
  exit 1
fi

# Rasterize an SVG to a transparent PNG at ${2}x${2} px. The transparent
# background (--default-background-color=00000000) is what keeps the icon corners
# and the tray glyph's negative space see-through.
rasterize() { # $1=svg  $2=size  $3=out.png
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size="$2,$2" --screenshot="$3" "file://$(pwd)/$1" >/dev/null 2>&1
}

# 0) App-icon master: assets/logo.svg → assets/logo.png at 1024px (transparent).
#    logo.svg is the source of truth; logo.png is a generated raster.
if [ -f "$SVG" ]; then
  rasterize "$SVG" 1024 "$SRC"
fi

# 1) Packaged-app + BrowserWindow / Windows icon: 1024px master PNG.
sips -s format png -z 1024 1024 "$SRC" --out build/icon.png >/dev/null

# 2) macOS .icns via a temporary iconset (sips preserves the transparent corners).
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

# 3) Monochrome menu-bar tray icon — a macOS TEMPLATE image rendered from its own
# single-color glyph (assets/tray.svg), NOT the full-color app logo. macOS
# recolors template images to match the menu bar (light/dark/selected); the
# renderer sets setTemplateImage(true). 18pt fits the ~22px menu bar; @2x is the
# retina representation actually shown on modern Macs.
if [ -f "$TRAY_SVG" ]; then
  TMP="$(mktemp -d)"
  rasterize "$TRAY_SVG" 1024 "$TMP/tray-1024.png"
  sips -s format png -z 18 18 "$TMP/tray-1024.png" --out assets/tray.png    >/dev/null
  sips -s format png -z 36 36 "$TMP/tray-1024.png" --out assets/tray@2x.png >/dev/null
  rm -rf "$TMP"
fi

# 4) In-app UI logo, served static from public/ (favicon + header brand mark).
sips -s format png -z 256 256 "$SRC" --out public/logo.png >/dev/null

echo "Icons regenerated from $SVG + $TRAY_SVG"
