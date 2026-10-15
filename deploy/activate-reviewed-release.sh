#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ $# == 4 && $EUID == 0 ]]
candidate="$1"
previous="$2"
bundle_hash="$3"
expected_tree="$4"
[[ "$candidate" =~ ^[0-9a-f]{40}$ && "$previous" =~ ^[0-9a-f]{40}$ ]]
[[ "$expected_tree" =~ ^[0-9a-f]{40}$ && "$bundle_hash" =~ ^[0-9a-f]{64}$ ]]
[[ "$candidate" != "$previous" ]]
stage="$(dirname "$(realpath "$0")")"
[[ "$stage" =~ ^/root/projects/copilot-api-release-staging/run-[0-9]+-[0-9]+$ ]]
release="/root/projects/copilot-api-releases/$candidate"
old_release="/root/projects/copilot-api-releases/$previous"
receipts="/root/projects/copilot-api-release-receipts/$(basename "$stage")"
main_pin="/etc/systemd/system/copilot-api.service.d/90-reviewed-release.conf"
watchdog_pin="/etc/systemd/system/copilot-api-watchdog.service.d/90-reviewed-release.conf"
env_file="/root/projects/copilot-api/.env"
main_hash="4126b12fafb27d93ce528790380d6d51b5891f84ab341c7cf2745f82baf7edc4"
watchdog_hash="623ff96c193de1e020f7a297fdeee959a9d545c9e5cfba3572d26b6bf5dffec8"
env_hash="085e6d1dc2b7870b77cf1fe16d039664fed254aaabea2c53d5d816041efc89b7"
armed=0
successful=0

digest() { sha256sum -- "$1" | cut -d ' ' -f 1; }
pid() { systemctl show "$1" --property=MainPID --value; }
healthy() { curl --fail --silent --show-error --max-time 5 --output /dev/null http://127.0.0.1:3131/; }
atomic_pin() {
  local temporary
  temporary="$(mktemp "$2.reviewed.XXXXXX")" || return 1
  if ! cp -a -- "$1" "$temporary" || ! mv -fT -- "$temporary" "$2"; then
    rm -f -- "$temporary"
    return 1
  fi
}
wait_healthy() {
  for _ in $(seq 1 30); do
    if healthy; then return 0; fi
    sleep 1
  done
  echo "Local readiness did not recover within the bounded wait." >&2
  return 1
}
matches_running_release() {
  local target="$1"
  [[ "$(readlink -f "/proc/$(pid copilot-api)/cwd")" == "$target" ]] || return 1
  tr '\0' '\n' < "/proc/$(pid copilot-api-watchdog)/cmdline" \
    | grep -Fxq "$target/deploy/token-watchdog.sh"
}
verify_process_environment() {
  [[ "$1" == absent || "$1" == enabled ]] || return 1
  python3 - "$(pid copilot-api)" "$1" <<'PY'
import pathlib
import sys

pid, mode = sys.argv[1:]
environment = dict(
    entry.split(b"=", 1)
    for entry in pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    if b"=" in entry
)
for name, expected in {
    "WEB_SEARCH_PROVIDER": "copilot",
    "STRUCTURED_OUTPUT_RECOVERY": "1",
    "WRITE_TOOL_RECOVERY": "1",
    "TOOL_SEARCH_RECOVERY": "1",
    "COPILOT_NATIVE_MESSAGES": "1",
}.items():
    if environment.get(name.encode()) != expected.encode():
        raise RuntimeError(f"The deployed process is missing the required flag: {name}")
expected_agent = b"1" if mode == "enabled" else None
if environment.get(b"AGENT_SCHEMA_CONSTRAINTS") != expected_agent:
    raise RuntimeError("The effective AGENT_SCHEMA_CONSTRAINTS flag differs from the required release state")
PY
}
unchanged_baseline() {
  [[ -f "$main_pin" && ! -L "$main_pin" && -f "$watchdog_pin" && ! -L "$watchdog_pin" ]] || return 1
  [[ "$(digest "$main_pin")" == "$main_hash" ]] || return 1
  [[ "$(digest "$watchdog_pin")" == "$watchdog_hash" ]] || return 1
  [[ "$(digest "$env_file")" == "$env_hash" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' "$env_file")" == "0:0:600" ]] || return 1
  [[ "$(git -C "$old_release" rev-parse HEAD)" == "$previous" ]] || return 1
  [[ -z "$(git -C "$old_release" status --porcelain)" ]] || return 1
  matches_running_release "$old_release" || return 1
  for unit in copilot-api copilot-api-watchdog nginx; do
    systemctl is-active --quiet "$unit" || return 1
  done
  verify_process_environment enabled
}
finish() {
  local result="$1"
  trap - EXIT
  trap '' INT TERM HUP PIPE
  if [[ "$successful" == 1 ]]; then return; fi
  if [[ "$result" == 0 ]]; then result=1; fi
  if [[ "$armed" == 1 ]]; then
    exec 1>&3 2>&3
    # Do not overwrite an unrelated concurrent change while rolling back.
    if [[ "$(digest "$main_pin")" != "$main_hash" ]] \
      && ! cmp -s "$main_pin" "$stage/main.after"; then
      echo "Rollback blocked by an unexpected main-service pin change." >&2
      exit 1
    fi
    if [[ "$(digest "$watchdog_pin")" != "$watchdog_hash" ]] \
      && ! cmp -s "$watchdog_pin" "$stage/watchdog.after"; then
      echo "Rollback blocked by an unexpected watchdog pin change." >&2
      exit 1
    fi
    echo "Activation failed; restoring both exact prior service pins." >&2 || true
    if ! cmp -s "$receipts/main.before" "$main_pin"; then
      atomic_pin "$receipts/main.before" "$main_pin"
    fi
    if ! cmp -s "$receipts/watchdog.before" "$watchdog_pin"; then
      atomic_pin "$receipts/watchdog.before" "$watchdog_pin"
    fi
    systemctl daemon-reload
    systemctl restart copilot-api
    systemctl restart copilot-api-watchdog
    wait_healthy
    unchanged_baseline
    printf 'rolled_back_to=%s\n' "$previous" > "$receipts/result.txt"
  fi
  exit "$result"
}
trap 'finish $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

exec 9>/run/lock/copilot-api-reviewed-release.lock
flock --nonblock 9
unchanged_baseline
healthy
[[ "$(digest "$stage/release.bundle")" == "$bundle_hash" ]]
[[ ! -e "$release" && ! -e "$receipts" ]]
install -d -m 700 "$receipts" "$stage/test-home"
exec 3>>"$receipts/rollback.log"
cp -a -- "$main_pin" "$receipts/main.before"
cp -a -- "$watchdog_pin" "$receipts/watchdog.before"
[[ "$(digest "$receipts/main.before")" == "$main_hash" ]]
[[ "$(digest "$receipts/watchdog.before")" == "$watchdog_hash" ]]
nginx_pid="$(pid nginx)"
sha256sum \
  /etc/nginx/nginx.conf \
  /etc/nginx/sites-available/candleviewer-copilot \
  /etc/nginx/sites-enabled/zz-candleviewer-copilot \
  /etc/letsencrypt/live/candleviewer.com/fullchain.pem \
  /etc/letsencrypt/renewal/candleviewer.com.conf \
  > "$receipts/protected.sha256"
systemctl show copilot-api copilot-api-watchdog nginx \
  --property=Id,MainPID,NRestarts,ActiveState,SubState \
  > "$receipts/services.before"

git clone --quiet --no-checkout --branch task-reviewed-release "$stage/release.bundle" "$release"
git -C "$release" checkout --quiet --detach "$candidate"
[[ "$(git -C "$release" rev-parse HEAD)" == "$candidate" ]]
[[ "$(git -C "$release" rev-parse 'HEAD^{tree}')" == "$expected_tree" ]]
git -C "$release" fsck --full --strict --no-dangling
git -C "$release" merge-base --is-ancestor "$previous" "$candidate"
git -C "$release" remote set-url origin https://github.com/basiltt/copilot-api.git

cd "$release"
export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Verification must not load production credentials or write production user data.
env -i HOME="$stage/test-home" PATH="$PATH" bun install --frozen-lockfile --ignore-scripts
env -i HOME="$stage/test-home" PATH="$PATH" bun run typecheck
env -i HOME="$stage/test-home" PATH="$PATH" bun run build
if ! env -i HOME="$stage/test-home" PATH="$PATH" bun test > "$receipts/tests.log" 2>&1; then
  tail -n 80 "$receipts/tests.log"
  exit 1
fi
tail -n 5 "$receipts/tests.log"
[[ -z "$(git status --porcelain)" ]]

python3 - "$receipts" "$stage" "$old_release" "$release" <<'PY'
import pathlib
import shutil
import sys

receipts, stage, old, new = sys.argv[1:]
for name in ("main", "watchdog"):
    source = pathlib.Path(receipts, name + ".before")
    destination = pathlib.Path(stage, name + ".after")
    original = source.read_bytes()
    if old.encode() not in original:
        raise RuntimeError("The original service pin lacks the expected release path")
    updated = original.replace(old.encode(), new.encode())
    if name == "main":
        if original.count(b"AGENT_SCHEMA_CONSTRAINTS") != 1 or (
            b"\nEnvironment=AGENT_SCHEMA_CONSTRAINTS=1\n" not in original
        ):
            raise RuntimeError("The baseline service pin must retain its enabled Agent constraints")
    shutil.copy2(source, destination)
    destination.write_bytes(updated)
PY

unchanged_baseline
sha256sum --check --status "$receipts/protected.sha256"
[[ "$(pid nginx)" == "$nginx_pid" ]]
armed=1
systemctl stop copilot-api-watchdog
atomic_pin "$stage/main.after" "$main_pin"
atomic_pin "$stage/watchdog.after" "$watchdog_pin"
systemctl daemon-reload
systemctl restart copilot-api
wait_healthy
# EnvironmentFile settings take precedence over Environment in a drop-in.
verify_process_environment enabled
systemctl start copilot-api-watchdog
for unit in copilot-api copilot-api-watchdog nginx; do
  systemctl is-active --quiet "$unit"
done
matches_running_release "$release"
main_pid="$(pid copilot-api)"
watchdog_pid="$(pid copilot-api-watchdog)"
main_restarts="$(systemctl show copilot-api --property=NRestarts --value)"
watchdog_restarts="$(systemctl show copilot-api-watchdog --property=NRestarts --value)"
sleep 15
[[ "$(pid copilot-api)" == "$main_pid" && "$(pid copilot-api-watchdog)" == "$watchdog_pid" ]]
[[ "$(systemctl show copilot-api --property=NRestarts --value)" == "$main_restarts" ]]
[[ "$(systemctl show copilot-api-watchdog --property=NRestarts --value)" == "$watchdog_restarts" ]]
[[ "$(pid nginx)" == "$nginx_pid" && "$(digest "$env_file")" == "$env_hash" ]]
[[ "$(stat -c '%u:%g:%a' "$env_file")" == "0:0:600" ]]
sha256sum --check --status "$receipts/protected.sha256"
cmp -s "$stage/main.after" "$main_pin"
cmp -s "$stage/watchdog.after" "$watchdog_pin"
curl --fail --silent --show-error --max-time 20 --output /dev/null https://candleviewer.com/
python3 - <<'PY'
import json
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:3131/v1/models", timeout=20) as response:
    models = json.load(response)
if not isinstance(models.get("data"), list) or not models["data"]:
    raise RuntimeError("The deployed model catalog is empty or malformed")
request = urllib.request.Request(
    "http://127.0.0.1:3131/v1/messages/count_tokens",
    data=json.dumps({
        "model": "claude-fable-5.1",
        "messages": [{"role": "user", "content": "Synthetic release verification."}],
    }).encode(),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=20) as response:
    result = json.load(response)
if type(result.get("input_tokens")) is not int or result["input_tokens"] <= 0:
    raise RuntimeError("The deployed token-count endpoint returned an invalid result")
print("Model catalog and bounded token-count protocol checks passed; no tools executed.")
PY
systemctl show copilot-api copilot-api-watchdog nginx \
  --property=Id,MainPID,NRestarts,ActiveState,SubState \
  > "$receipts/services.after"
printf 'deployed_commit=%s\ntree=%s\nrollback_commit=%s\nbundle_sha256=%s\n' \
  "$candidate" "$expected_tree" "$previous" "$bundle_hash" > "$receipts/result.txt"
successful=1
cat "$receipts/result.txt"
cat "$receipts/services.after"
