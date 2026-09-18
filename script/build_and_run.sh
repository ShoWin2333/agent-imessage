#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
APP_NAME="${AGENT_GATEWAY_APP_NAME:-Agent iMessage}"
BUNDLE_ID="${AGENT_GATEWAY_BUNDLE_ID:-app.agent-imessage.desktop}"
if [[ ! "$APP_NAME" =~ ^[A-Za-z0-9\ _-]+$ || ! "$BUNDLE_ID" =~ ^[A-Za-z0-9.-]+$ ]]; then echo 'Invalid app identity' >&2; exit 2; fi
case "$MODE" in run|--verify|--logs) ;; *) echo "Usage: $0 [run|--verify|--logs]" >&2; exit 2 ;; esac
cd "$ROOT_DIR"
# The app owns only services it starts. Quit gracefully to allow launchd cleanup.
if pgrep -x "$APP_NAME" >/dev/null; then
  osascript -e "tell application id \"$BUNDLE_ID\" to quit"
  for _ in {1..100}; do
    if ! pgrep -x "$APP_NAME" >/dev/null; then break; fi
    sleep 0.2
  done
  if pgrep -x "$APP_NAME" >/dev/null; then echo 'The app is still shutting down; try again shortly.' >&2; exit 1; fi
fi
npm run build
OUTPUT_DIR="$(mktemp -d /private/tmp/agent-gateway-desktop.XXXXXX)"
APP_PATH="$OUTPUT_DIR/$APP_NAME.app"
if [[ -n "${AGENT_GATEWAY_SERVICE_PLIST:-}" ]]; then
  node scripts/macos/build.mjs "$APP_PATH" "$AGENT_GATEWAY_SERVICE_PLIST"
else
  node scripts/macos/build.mjs "$APP_PATH"
fi
/usr/bin/open -n "$APP_PATH"
if [[ "$MODE" == '--verify' ]]; then
  sleep 2
  pgrep -x "$APP_NAME" >/dev/null
  echo "Verified running app: $APP_PATH"
elif [[ "$MODE" == '--logs' ]]; then
  /usr/bin/log stream --info --style compact --predicate 'process == "Agent iMessage"'
fi
