#!/usr/bin/env bash
# Shared helpers for the two-device (iOS sim + Android emulator) sync E2E.
#
# Factory template (templates/e2e-two-device/) — synced verbatim into each
# shared-sync consumer's scripts/e2e/. Do NOT fork per app: the per-app
# orchestration (which flow runs when, where the offline windows fall) lives in
# the app-owned run-two-device.sh / run-chaos.sh that SOURCE this lib. Config
# comes from scripts/e2e/e2e.config.sh (app-owned).
#
# Contract the sourcing script must satisfy (usually via e2e.config.sh):
#   APP_ID          android/ios bundle id            (e.g. com.joshapproved.grocerylist)
#   ANDROID_APK     path to the debug apk            (build/outputs/.../app-debug.apk)
#   FLOWS           abs dir of the app's Maestro flows
#   IOS_UDID        booted iOS simulator udid        (arg 1 to the runner)
#   ANDROID_SERIAL  adb serial (default emulator-5554)
#   RELAY_PORT      hermetic mini-relay port         (default 7447)
#   CHAOS_PORT      toxiproxy front-end port         (default 7448)
#   E2E_DIR         abs dir containing this lib + the relays

set -euo pipefail

: "${ANDROID_SERIAL:=emulator-5554}"
: "${RELAY_PORT:=7447}"
: "${CHAOS_PORT:=7448}"

h_step() { printf '\n=== %s ===\n' "$*"; }
h_ios()   { maestro --device "$IOS_UDID" test "$FLOWS/$1"; }
h_droid() { maestro --device "$ANDROID_SERIAL" test "$FLOWS/$1"; }

# Fresh Android state via reinstall + two warm-up launches. NOT Maestro
# clearState / pm clear: the first launch after a wipe races expo-sqlite's
# directory creation and hydrate fails, so the QA fixtures never seed. Reinstall
# + warm-up gives the first real flow a fresh-but-healthy DB to relaunch into.
h_reset_android() {
  # Restore the radios BEFORE anything else. A suite that cuts the network for
  # an offline window and then dies inside it leaves the emulator offline for
  # good: the EXIT trap below covers an ordinary abort, but an OOM jetsam kill
  # or `kill -9` never runs a trap, and on the 8 GB mini that is the normal way
  # these runs die. The damage lands on the NEXT run, which fails at a totally
  # unrelated assertion — phase 1's "Connected" — sending the reader into the
  # sync/relay code instead of at leftover device state. That is exactly what
  # happened on 2026-08-28: the 2026-08-25 run died at phase 4, immediately
  # after h_android_offline, and every run after it was doomed before it began.
  h_android_online_safe
  adb -s "$ANDROID_SERIAL" uninstall "$APP_ID" >/dev/null 2>&1 || true
  adb -s "$ANDROID_SERIAL" install -r "$ANDROID_APK" >/dev/null
  adb -s "$ANDROID_SERIAL" shell am start -n "$APP_ID/.MainActivity" >/dev/null
  sleep 20
  adb -s "$ANDROID_SERIAL" shell am force-stop "$APP_ID"
  adb -s "$ANDROID_SERIAL" shell am start -n "$APP_ID/.MainActivity" >/dev/null
  sleep 10
  adb -s "$ANDROID_SERIAL" shell am force-stop "$APP_ID"
}

h_ios_terminate() { xcrun simctl terminate "$IOS_UDID" "$APP_ID" 2>/dev/null || true; }

h_android_offline() {
  adb -s "$ANDROID_SERIAL" shell svc wifi disable
  adb -s "$ANDROID_SERIAL" shell svc data disable
}
h_android_online() {
  adb -s "$ANDROID_SERIAL" shell svc wifi enable
  adb -s "$ANDROID_SERIAL" shell svc data enable
}

# Best-effort network restore. Never fails, never aborts its caller — it runs
# both from the EXIT trap (where a non-zero would rewrite the run's exit code)
# and from h_reset_android (where the device may not be attached yet).
h_android_online_safe() {
  [ -n "${ANDROID_SERIAL:-}" ] || return 0
  adb -s "$ANDROID_SERIAL" shell svc wifi enable >/dev/null 2>&1 || true
  adb -s "$ANDROID_SERIAL" shell svc data enable >/dev/null 2>&1 || true
  return 0
}

# --- relay lifecycle ---------------------------------------------------------
# The hermetic mini-relay (local ONLY — never a public relay).
_RELAY_PID=""
h_start_relay() {
  node "$E2E_DIR/mini-relay.mjs" --port "$RELAY_PORT" "$@" &
  _RELAY_PID=$!
  sleep 1
  echo "mini-relay pid=$_RELAY_PID on ws://127.0.0.1:$RELAY_PORT"
}
h_stop_relay() { [ -n "$_RELAY_PID" ] && kill "$_RELAY_PID" 2>/dev/null || true; }

# --- chaos lifecycle ---------------------------------------------------------
# Boots toxiproxy + mini-relay behind CHAOS_PORT and runs a NAMED scenario's
# fault schedule. Point Metro's EXPO_PUBLIC_SYNC_RELAYS at CHAOS_PORT for a
# chaos run (ws://127.0.0.1:$CHAOS_PORT + ws://10.0.2.2:$CHAOS_PORT for Android).
_CHAOS_PID=""
h_start_chaos() {
  local scenario="$1"
  command -v toxiproxy-server >/dev/null 2>&1 || {
    echo "toxiproxy-server not on PATH — brew install toxiproxy" >&2
    return 3
  }
  node "$E2E_DIR/chaos-relay.mjs" --scenario "$scenario" \
    --port "$CHAOS_PORT" --relay-port "$RELAY_PORT" &
  _CHAOS_PID=$!
  echo "chaos-relay pid=$_CHAOS_PID scenario=$scenario on ws://127.0.0.1:$CHAOS_PORT"
}
h_stop_chaos() { [ -n "$_CHAOS_PID" ] && kill "$_CHAOS_PID" 2>/dev/null || true; }

# --- gate artifact -----------------------------------------------------------
# Writes qa/e2e-sync-report.json — the artifact run-qa.mjs's two-device tier
# reads (read-only, like the device matrix). Called at the END of a runner, so
# under `set -e` it only fires on a fully green run → ok:true. Args:
#   h_write_report <suite> <ok:true|false> <scenario-name>...
h_write_report() {
  local suite="$1"; local ok="$2"; shift 2
  local scenarios="" first=1
  for name in "$@"; do
    [ $first -eq 1 ] && first=0 || scenarios+=","
    scenarios+="{\"name\":\"$name\",\"ok\":$ok}"
  done
  local out="qa/e2e-sync-report.json"
  mkdir -p qa
  printf '{"suite":"%s","ok":%s,"scenarios":[%s]}\n' "$suite" "$ok" "$scenarios" > "$out"
  echo "wrote $out (suite=$suite ok=$ok)"
}

# Runs on EVERY exit, green or red. Restoring the radios is part of cleanup for
# the same reason killing the relay is: an offline window is borrowed device
# state, and a suite that borrows it owes it back even when it fails. Ordinary
# aborts (a failed assertion under `set -e`, Ctrl-C) land here; the belt to this
# brace is h_reset_android's restore, which also covers a kill that skips traps.
h_cleanup() {
  local rc=$?
  h_stop_chaos
  h_stop_relay
  h_android_online_safe
  return $rc
}
trap h_cleanup EXIT
