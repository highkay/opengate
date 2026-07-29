#!/bin/sh
set -eu

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

cleanup_manual_browser() {
  for pid in ${MANUAL_BROWSER_PIDS:-}; do
    kill "$pid" 2>/dev/null || true
  done
  rm -f /tmp/qwen-vnc-password
}

start_manual_browser() {
  if [ -z "${BROWSER_VNC_PASSWORD:-}" ]; then
    echo "MANUAL_BROWSER_ENABLED=true requires BROWSER_VNC_PASSWORD; refusing to expose noVNC without authentication" >&2
    exit 1
  fi

  DISPLAY="${DISPLAY:-:99}"
  BROWSER_NOVNC_PORT="${BROWSER_NOVNC_PORT:-7900}"
  BROWSER_VNC_PORT="${BROWSER_VNC_PORT:-5900}"
  BROWSER_SCREEN_GEOMETRY="${BROWSER_SCREEN_GEOMETRY:-1920x1080x24}"
  export DISPLAY

  case "$BROWSER_NOVNC_PORT:$BROWSER_VNC_PORT" in
    *[!0-9:]*) echo "Browser console ports must be numeric" >&2; exit 1 ;;
  esac

  password_file=/tmp/qwen-vnc-password
  rm -f "$password_file"
  x11vnc -storepasswd "$BROWSER_VNC_PASSWORD" "$password_file" >/dev/null
  chmod 600 "$password_file"

  Xvfb "$DISPLAY" -screen 0 "$BROWSER_SCREEN_GEOMETRY" -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
  xvfb_pid=$!
  MANUAL_BROWSER_PIDS="$xvfb_pid"

  display_number=${DISPLAY#:}
  display_number=${display_number%%.*}
  attempts=0
  while [ ! -S "/tmp/.X11-unix/X${display_number}" ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 50 ]; then
      echo "Xvfb did not become ready on DISPLAY=$DISPLAY" >&2
      exit 1
    fi
    sleep 0.1
  done

  fluxbox -display "$DISPLAY" >/tmp/fluxbox.log 2>&1 &
  fluxbox_pid=$!
  MANUAL_BROWSER_PIDS="$MANUAL_BROWSER_PIDS $fluxbox_pid"

  x11vnc -display "$DISPLAY" -rfbauth "$password_file" -rfbport "$BROWSER_VNC_PORT" -localhost -forever -shared -noxdamage -repeat \
    >/tmp/x11vnc.log 2>&1 &
  x11vnc_pid=$!
  MANUAL_BROWSER_PIDS="$MANUAL_BROWSER_PIDS $x11vnc_pid"

  websockify --web=/usr/share/novnc/ "0.0.0.0:${BROWSER_NOVNC_PORT}" "127.0.0.1:${BROWSER_VNC_PORT}" \
    >/tmp/novnc.log 2>&1 &
  novnc_pid=$!
  MANUAL_BROWSER_PIDS="$MANUAL_BROWSER_PIDS $novnc_pid"

  sleep 0.2
  for pid in $MANUAL_BROWSER_PIDS; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Manual browser console failed to start; inspect /tmp/xvfb.log, /tmp/x11vnc.log, and /tmp/novnc.log" >&2
      exit 1
    fi
  done

  echo "Manual browser console enabled on noVNC port ${BROWSER_NOVNC_PORT} with password authentication"
}

if ! is_true "${MANUAL_BROWSER_ENABLED:-false}"; then
  exec "$@"
fi

trap cleanup_manual_browser EXIT
start_manual_browser

app_pid=''
forward_signal() {
  signal=$1
  if [ -n "$app_pid" ]; then
    kill -"$signal" "$app_pid" 2>/dev/null || true
  fi
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
"$@" &
app_pid=$!
set +e
wait "$app_pid"
status=$?
set -e
exit "$status"
