#!/usr/bin/env bash
# Watchdog for copilot-api.
#
# Follows the systemd journal for the copilot-api service and restarts it when
# the upstream Copilot "token expired" error appears. Restarting forces the app
# to run setupCopilotToken() again, fetching a fresh Copilot token.
#
# Safety:
#   * COOLDOWN     - minimum seconds between restarts (debounces error bursts).
#   * MAX_PER_HOUR - hard cap on restarts per rolling hour (avoids restart loops
#                    when the underlying GitHub token is truly dead).
set -uo pipefail

SERVICE="${SERVICE:-copilot-api.service}"
# Extended-regex of log lines that indicate a dead/stale Copilot token and
# warrant a restart. Covers two failure modes:
#   1. Upstream 401 on a request: "...token expired: unauthorized: token expired"
#   2. The in-app periodic refresh failing (src/lib/token.ts rethrows, producing
#      "Failed to refresh Copilot token" + an unhandled promise rejection).
PATTERN="${PATTERN:-token expired: unauthorized: token expired|Failed to refresh Copilot token|Unhandled promise rejection: Failed to get Copilot token}"
COOLDOWN="${COOLDOWN:-120}"
MAX_PER_HOUR="${MAX_PER_HOUR:-6}"

STATE_DIR="${STATE_DIR:-/var/lib/copilot-api-watchdog}"
LAST_RESTART_FILE="$STATE_DIR/last_restart"
HISTORY_FILE="$STATE_DIR/history"
mkdir -p "$STATE_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Prune restart history to the last hour and return the remaining count.
restarts_last_hour() {
  local now=$1 cutoff ts count=0
  cutoff=$((now - 3600))
  local tmp="$STATE_DIR/.history.tmp"
  : > "$tmp"
  if [[ -f "$HISTORY_FILE" ]]; then
    while read -r ts; do
      [[ -z "$ts" ]] && continue
      if (( ts >= cutoff )); then
        echo "$ts" >> "$tmp"
        count=$((count + 1))
      fi
    done < "$HISTORY_FILE"
  fi
  mv "$tmp" "$HISTORY_FILE"
  echo "$count"
}

log "Watchdog started; following journal for $SERVICE (cooldown=${COOLDOWN}s, cap=${MAX_PER_HOUR}/h)"

# -n0 => start at the tail, only react to errors that happen from now on.
journalctl -u "$SERVICE" -f -n0 -o cat 2>/dev/null | while IFS= read -r line; do
  if [[ "$line" =~ $PATTERN ]]; then
      now=$(date +%s)

      last=0
      [[ -f "$LAST_RESTART_FILE" ]] && last=$(cat "$LAST_RESTART_FILE" 2>/dev/null || echo 0)
      if (( now - last < COOLDOWN )); then
        continue
      fi

      count=$(restarts_last_hour "$now")
      if (( count >= MAX_PER_HOUR )); then
        log "Detected token failure but restart cap reached (${count}/${MAX_PER_HOUR} in last hour); backing off"
        echo "$now" > "$LAST_RESTART_FILE"
        continue
      fi

      log "Detected token failure -> restarting $SERVICE"
      if systemctl restart "$SERVICE"; then
        echo "$now" > "$LAST_RESTART_FILE"
        echo "$now" >> "$HISTORY_FILE"
        log "Restarted $SERVICE successfully"
      else
        log "ERROR: failed to restart $SERVICE"
      fi
  fi
done
