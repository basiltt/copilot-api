#!/usr/bin/env bash
# Functional test for token-watchdog.sh using stubbed journalctl/systemctl.
set -uo pipefail

WD=/root/projects/copilot-api/deploy/token-watchdog.sh
sed -i 's/\r$//' "$WD"; chmod +x "$WD"

TESTROOT=/tmp/wdtest
rm -rf "$TESTROOT"; mkdir -p "$TESTROOT/bin"

MATCH='10:45:00 AM x POST /v1/messages claude 401 221ms IDE token expired: unauthorized: token expired'
MATCH2=' ERROR  Failed to refresh Copilot token: Failed to get Copilot token'

# Stub journalctl: emit a 401 line, then (after >cooldown) a "Failed to refresh" line.
cat > "$TESTROOT/bin/journalctl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "$MATCH"
printf '%s\n' "$MATCH"
sleep 3
printf '%s\n' "$MATCH2"
sleep 1
EOF

# Stub systemctl: record each call instead of really restarting.
cat > "$TESTROOT/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "[$(date '+%H:%M:%S')] STUB systemctl $*" >> /tmp/wdtest/actions.log
exit 0
EOF
chmod +x "$TESTROOT/bin/"*
: > "$TESTROOT/actions.log"

echo "=== TEST 1: two patterns + cooldown (expect 2 restarts: 401 trigger, suppress dup, refresh-fail trigger) ==="
PATH="$TESTROOT/bin:$PATH" STATE_DIR="$TESTROOT/state1" COOLDOWN=2 MAX_PER_HOUR=6 \
  timeout 15 bash "$WD" 2>&1 | sed 's/^/  /'
echo "  --- systemctl calls ---"
cat "$TESTROOT/actions.log" | sed 's/^/  /'
c1=$(grep -c 'restart' "$TESTROOT/actions.log")
echo "  restart count = $c1 (expected 2)"

: > "$TESTROOT/actions.log"
echo
echo "=== TEST 2: hourly cap (MAX_PER_HOUR=1, expect only 1 restart) ==="
PATH="$TESTROOT/bin:$PATH" STATE_DIR="$TESTROOT/state2" COOLDOWN=1 MAX_PER_HOUR=1 \
  timeout 15 bash "$WD" 2>&1 | sed 's/^/  /'
echo "  --- systemctl calls ---"
cat "$TESTROOT/actions.log" | sed 's/^/  /'
c2=$(grep -c 'restart' "$TESTROOT/actions.log")
echo "  restart count = $c2 (expected 1)"

echo
if [[ "$c1" == "2" && "$c2" == "1" ]]; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL (test1=$c1 want 2, test2=$c2 want 1)"
fi
rm -rf "$TESTROOT"
