#!/usr/bin/env bash
# A private, headless GNOME Shell for checking GNOME-only behaviour without a desktop.
#
# It never touches the user's running session: its own dbus (dbus-run-session), its own
# XDG_RUNTIME_DIR (short path under /tmp, the Wayland socket path must stay < 108 bytes),
# its own HOME/XDG dirs, and WAYLAND_DISPLAY/DISPLAY removed from the parent env first.
#
#   scripts/linux-gnome-headless.sh start      start shell (+ pipewire for ScreenCast)
#   scripts/linux-gnome-headless.sh env        print `export ...` lines; eval "$(... env)"
#   scripts/linux-gnome-headless.sh launch BIN [ARGS]   start an app inside the shell
#   scripts/linux-gnome-headless.sh windows    list windows the headless shell manages
#   scripts/linux-gnome-headless.sh shot FILE  screenshot of the virtual monitor (PNG)
#   scripts/linux-gnome-headless.sh eval JS    run JS in the shell (unsafe mode is on)
#   scripts/linux-gnome-headless.sh stop       kill everything this script started
#
# Env knobs: GH_STATE (default ~/.cache/trove-gnome-headless), GH_SIZE (1280x800),
#            GH_BACKEND for launch: wayland (default) or x11 (Xwayland of the headless shell).
#
# ⛔ Keys from scripts/linux-remote-input.py reach an X11 app only (2026-10-23, mutter 50.1):
#    Trove launched with the default wayland backend ignored Ctrl+L, with and without a click
#    first; GH_BACKEND=x11 selected the address bar. Wayland is fine for screenshots.
set -euo pipefail

STATE="${GH_STATE:-$HOME/.cache/trove-gnome-headless}"
SIZE="${GH_SIZE:-1280x800}"
ENVF="$STATE/env"

die() { echo "linux-gnome-headless: $*" >&2; exit 1; }

load_env() {
  [[ -f "$ENVF" ]] || die "not running (no $ENVF); run start first"
  # shellcheck disable=SC1090
  source "$ENVF"
}

# gdbus against the PRIVATE bus only.
pgdbus() { env -u WAYLAND_DISPLAY -u DISPLAY DBUS_SESSION_BUS_ADDRESS="$GH_DBUS" gdbus "$@"; }

shell_eval() {
  # Eval over the PRIVATE bus; prints the JS result, exits 1 on a JS error.
  env -u WAYLAND_DISPLAY -u DISPLAY python3 -c '
import sys
from gi.repository import Gio, GLib
c = Gio.DBusConnection.new_for_address_sync(sys.argv[1],
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
ok, res = c.call_sync("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "Eval",
    GLib.Variant("(s)", (sys.argv[2],)), None, 0, 10000, None).unpack()
print(res)
sys.exit(0 if ok else 1)' "$GH_DBUS" "$1"
}

cmd_start() {
  if [[ -f "$ENVF" ]]; then
    source "$ENVF"
    if kill -0 "$GH_PID" 2>/dev/null; then die "already running (pid $GH_PID)"; fi
  fi
  mkdir -p "$STATE"/{home,config,data,cache}
  local rt; rt=$(mktemp -d /tmp/gsr.XXXX); chmod 700 "$rt"
  local busf="$STATE/bus"; rm -f "$busf"
  # dconf/gsettings defaults for the private user: no screen lock, no welcome tour.
  : >"$STATE/shell.log"
  env -i PATH="$PATH" HOME="$STATE/home" USER="$USER" LANG="${LANG:-C.UTF-8}" \
      XDG_RUNTIME_DIR="$rt" XDG_CONFIG_HOME="$STATE/config" XDG_DATA_HOME="$STATE/data" \
      XDG_CACHE_HOME="$STATE/cache" XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME \
      setsid dbus-run-session -- bash -c '
        echo "$DBUS_SESSION_BUS_ADDRESS" >"'"$busf"'"
        gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
        gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
        gsettings set org.gnome.desktop.interface enable-hot-corners false 2>/dev/null || true
        gsettings set org.gnome.shell welcome-dialog-last-shown-version "999" 2>/dev/null || true
        pipewire >"'"$STATE"'/pipewire.log" 2>&1 &
        exec gnome-shell --headless --wayland --unsafe-mode --virtual-monitor '"$SIZE"'
      ' >>"$STATE/shell.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 100); do
    [[ -S "$rt/wayland-0" && -s "$busf" ]] && break
    kill -0 "$pid" 2>/dev/null || { tail -20 "$STATE/shell.log"; die "shell exited"; }
    sleep 0.2
  done
  [[ -S "$rt/wayland-0" ]] || die "no wayland-0 in $rt after 20 s"
  cat >"$ENVF" <<EOF
GH_PID=$pid
GH_RT=$rt
GH_DBUS='$(cat "$busf")'
GH_STATE='$STATE'
EOF
  source "$ENVF"
  # Wait until the shell answers on the private bus.
  for _ in $(seq 1 50); do
    shell_eval '1' >/dev/null 2>&1 && break; sleep 0.2
  done
  local ver; ver=$(pgdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
      --method org.freedesktop.DBus.Properties.Get org.gnome.Shell ShellVersion)
  # Leave the overview so app windows get focus.
  shell_eval 'Main.overview.hide(); "ok"' >/dev/null || true
  echo "started: pid $pid, runtime $rt, shell $ver"
}

cmd_env() {
  load_env
  echo "unset WAYLAND_DISPLAY DISPLAY"
  echo "export XDG_RUNTIME_DIR='$GH_RT' WAYLAND_DISPLAY=wayland-0 DBUS_SESSION_BUS_ADDRESS='$GH_DBUS'"
  echo "export HOME='$STATE/home' XDG_CONFIG_HOME='$STATE/config' XDG_DATA_HOME='$STATE/data' XDG_CACHE_HOME='$STATE/cache'"
}

# Xwayland of the headless shell (started on demand by mutter); empty if none yet.
xdisplay() { shell_eval 'imports.gi.GLib.getenv("DISPLAY") ?? ""' 2>/dev/null | tr -d '"'; }
xauth() { shell_eval 'imports.gi.GLib.getenv("XAUTHORITY") ?? ""' 2>/dev/null | tr -d '"'; }

cmd_launch() {
  load_env
  [[ $# -ge 1 ]] || die "launch needs a program"
  local backend="${GH_BACKEND:-wayland}" disp="" xa=""
  if [[ "$backend" == x11 ]]; then
    disp=$(xdisplay); xa=$(xauth)
    [[ -n "$disp" && "$disp" != ":0" ]] || die "headless Xwayland DISPLAY is '$disp'; refusing"
  fi
  local log="$STATE/app-$(basename "$1")-$(date +%H%M%S).log"
  env -u WAYLAND_DISPLAY -u DISPLAY \
      HOME="$STATE/home" XDG_CONFIG_HOME="$STATE/config" XDG_DATA_HOME="$STATE/data" \
      XDG_CACHE_HOME="$STATE/cache" XDG_RUNTIME_DIR="$GH_RT" \
      DBUS_SESSION_BUS_ADDRESS="$GH_DBUS" XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland \
      ${disp:+DISPLAY=$disp} ${xa:+XAUTHORITY=$xa} \
      $([[ "$backend" == x11 ]] && echo GDK_BACKEND=x11 || echo WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland) \
      setsid "$@" >"$log" 2>&1 &
  echo "$!" >>"$STATE/apps.pids"
  echo "launched pid $! ($backend${disp:+ $disp}), log $log"
}

cmd_windows() {
  load_env
  shell_eval 'JSON.stringify(global.get_window_actors().map(a => { const w = a.meta_window; const r = w.get_frame_rect(); return {title: w.get_title(), wmclass: w.get_wm_class(), pid: w.get_pid(), x11: w.get_client_type() === 1, focus: w.has_focus(), rect: [r.x, r.y, r.width, r.height]}; }))'
}

cmd_shot() {
  load_env
  local out="${1:?shot needs an output file}"
  out=$(realpath -m "$out")
  local res
  res=$(pgdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$out")
  [[ "$res" == "(true,"* ]] || die "screenshot failed: $res"
  echo "$out"
}

cmd_stop() {
  [[ -f "$ENVF" ]] || { echo "not running"; return 0; }
  source "$ENVF"
  if [[ -f "$STATE/apps.pids" ]]; then
    while read -r p; do kill "$p" 2>/dev/null || true; done <"$STATE/apps.pids"
    rm -f "$STATE/apps.pids"
  fi
  # X displays held by THIS shell (lock file pid = our gnome-shell); cleaned after the kill.
  local ourx=()
  for lk in /tmp/.X*-lock; do
    [[ -f "$lk" ]] || continue
    local lp; lp=$(tr -d ' ' <"$lk")
    if tr '\0' '\n' <"/proc/$lp/environ" 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=$GH_RT"; then
      ourx+=("$(basename "$lk" | sed -E 's/^\.X([0-9]+)-lock$/\1/')")
    fi
  done
  # The whole session group: dbus-run-session, dbus-daemon, gnome-shell, pipewire, Xwayland.
  kill -- -"$GH_PID" 2>/dev/null || kill "$GH_PID" 2>/dev/null || true
  sleep 1
  pkill -KILL -f "XDG_RUNTIME_DIR=$GH_RT" 2>/dev/null || true
  for p in $(pgrep -u "$USER" -f 'gnome-shell --headless|Xwayland|pipewire|dbus-daemon' || true); do
    if tr '\0' '\n' <"/proc/$p/environ" 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=$GH_RT"; then
      kill -KILL "$p" 2>/dev/null || true
    fi
  done
  for n in "${ourx[@]}"; do rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"; done
  rm -rf "$GH_RT" "$ENVF"
  echo "stopped"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  env) cmd_env ;;
  launch) shift; cmd_launch "$@" ;;
  windows) cmd_windows ;;
  shot) shift; cmd_shot "$@" ;;
  eval) shift; load_env; shell_eval "$1" ;;
  stop) cmd_stop ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
