#!/bin/bash
# Restart the Claude proxy WITHOUT severing in-flight responses.
#
# Do not use `launchctl kickstart -k`. It SIGTERMs and then SIGKILLs after 60s
# (launchd clamps ExitTimeOut to 60 no matter what the plist says), which cuts
# long answers mid-body. The client sees
#   TransferEncodingError: Not enough data to satisfy transfer length header
# and in Open WebUI the aborted save orphans a message, breaking the chat with
# "Parent message not found".
#
# Instead: ask the process to drain and exit itself; KeepAlive restarts it.
set -euo pipefail
PORT="${1:-3456}"
LABEL="com.claude-code-provider"

if ! curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "Proxy not responding; starting it instead."
  launchctl kickstart "gui/$(id -u)/$LABEL"
  exit 0
fi

OLD_PID="$(pgrep -f 'standalone.js' | head -1 || true)"
echo "Draining (pid ${OLD_PID:-unknown})..."
curl -sf -m 10 -X POST "http://127.0.0.1:$PORT/admin/drain" >/dev/null

# Wait for the old process to finish its work and exit on its own.
for _ in $(seq 1 240); do          # up to 20 min
  if [ -z "$OLD_PID" ] || ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
  sleep 5
done

if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  echo "WARNING: old process still alive after 20 min; leaving it alone." >&2
  exit 1
fi

echo "Drained. Waiting for KeepAlive to bring it back..."
for _ in $(seq 1 60); do
  if curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null; then
    echo "Proxy healthy (pid $(pgrep -f 'standalone.js' | head -1))."
    exit 0
  fi
  sleep 2
done
echo "ERROR: proxy did not come back healthy." >&2
exit 1
