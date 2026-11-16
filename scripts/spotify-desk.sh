#!/usr/bin/env bash
# Spotify vive en un escritorio virtual fijo. Este script va a ese escritorio;
# si Spotify no está abierto lo arranca, y si su ventana anda en otro
# escritorio la trae al suyo.
#
# Uso: spotify-desk.sh [número de escritorio, empezando en 1]   (por defecto 8)
set -u
desk=$(( ${1:-8} - 1 ))

# Ventanas de Spotify gestionadas por el WM (las auxiliares devuelven -1).
windows() {
  xdotool search --class spotify 2>/dev/null | while read -r w; do
    d=$(xdotool get_desktop_for_window "$w" 2>/dev/null) || continue
    [ "$d" != "-1" ] && echo "$w"
  done
}

if [ -z "$(windows)" ]; then
  setsid spotify >/dev/null 2>&1 &
  for _ in $(seq 1 60); do          # hasta 15 s a que aparezca la ventana
    sleep 0.25
    [ -n "$(windows)" ] && break
  done
fi

for w in $(windows); do
  xdotool set_desktop_for_window "$w" "$desk"
done
xdotool set_desktop "$desk"
