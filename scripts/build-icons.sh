#!/usr/bin/env bash
# Собирает иконки реестра из assets/icon-master.png: обрезает поля,
# делает белый фон прозрачным и раскладывает по размерам и темам.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/icon-master.png"
OUT="$ROOT/assets"
PAD=8   # поле вокруг знака, процентов от стороны

[ -f "$SRC" ] || { echo "нет исходника: $SRC" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# знак без полей, на прозрачном фоне, вписанный в квадрат с равным полем
magick "$SRC" -fuzz 12% -trim +repage -background none -alpha set \
  -fuzz 12% -transparent white "$WORK/glyph.png"

SIDE=$(magick identify -format "%[fx:max(w,h)]" "$WORK/glyph.png")
CANVAS=$(( SIDE * (100 + PAD * 2) / 100 ))
magick "$WORK/glyph.png" -background none -gravity center \
  -extent "${CANVAS}x${CANVAS}" "$WORK/square.png"

# тёмная тема: тот же знак белым
magick "$WORK/square.png" -channel RGB -negate +channel "$WORK/square-dark.png"

for size in 512 128 48; do
  magick "$WORK/square.png" -filter Lanczos -resize "${size}x${size}" \
    -strip "$OUT/icon-${size}.png"
  magick "$WORK/square-dark.png" -filter Lanczos -resize "${size}x${size}" \
    -strip "$OUT/icon-dark-${size}.png"
done

magick identify -format "%f  %wx%h  alpha=%A\n" "$OUT"/icon-*.png
