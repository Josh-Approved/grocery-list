#!/usr/bin/env bash
# Two-device sync E2E UNDER NETWORK CHAOS (grocery). For each named toxiproxy
# scenario the app's shared list is exercised while the fault schedule runs,
# then the intent + honesty oracles are asserted:
#   intent   — the gap write converges; no duplicate, no resurrected item
#              (reuses the baseline add/verify + reported-defect flows)
#   honesty  — while delivery is failing the status indicator must NOT read
#              "Connected" (chaos-honesty.yaml); it reads "Offline" (link cut)
#              or "Not syncing" (publishes rejected). The 2026-07-04 fix,
#              kept honest under every fault.
#
# Metro must point at the CHAOS_PORT for this run (the phones connect through
# toxiproxy, not straight at the mini-relay):
#   EXPO_PUBLIC_SYNC_RELAYS="ws://127.0.0.1:7448,ws://10.0.2.2:7448" \
#   EXPO_PUBLIC_QA_MODE=1 EXPO_PUBLIC_QA_SHARE_SECRET=<base64-32B> \
#   npx expo start --port 8081
#
# Usage: scripts/e2e/run-chaos.sh <ios-sim-udid> [android-serial] [scenario...]
set -euo pipefail

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Mac-mini load governor (Uplevel 3 / T5) ──────────────────────────────────
# The full chaos sweep (two device drivers + Metro + toxiproxy, once per scenario)
# is ONE heavy unit; on the 8 GB mini heavy work must run one-at-a-time. Re-exec
# the whole script under the factory's machine-wide heavy-lock CLI shim (a no-op
# on a full-size machine). JA_HEAVY_HELD is set once inside the lock, so this
# fires exactly once, BEFORE the arg shifts below (so "$@" is still the original).
# If the factory sibling isn't present we run unguarded — the lock only matters on
# the mini, where the factory is always a sibling.
if [ -z "${JA_HEAVY_HELD:-}" ]; then
  _JA_HEAVY="$E2E_DIR/../../../josh-approved-factory/scripts/lib/heavy.mjs"
  if [ -f "$_JA_HEAVY" ]; then
    _JA_APP="$(basename "$(cd "$E2E_DIR/../.." && pwd)")"
    exec node "$_JA_HEAVY" run --label "e2e:$_JA_APP" -- "$0" "$@"
  fi
fi

IOS_UDID="${1:?usage: run-chaos.sh <ios-sim-udid> [android-serial] [scenario...]}"
shift
ANDROID_SERIAL="${1:-emulator-5554}"; [ $# -gt 0 ] && shift || true
# shellcheck source=/dev/null
source "$E2E_DIR/e2e.config.sh"
# shellcheck source=/dev/null
source "$E2E_DIR/harness-lib.sh"

SCENARIOS=("$@")
if [ ${#SCENARIOS[@]} -eq 0 ]; then
  SCENARIOS=(partition-mid-sync slow-drip lossy disconnect-on-write flap)
fi

for scenario in "${SCENARIOS[@]}"; do
  h_step "chaos scenario: $scenario"
  h_ios_terminate
  h_reset_android

  # Sit Android on the list to receive; boot iOS onto the list.
  h_droid 01-android-open.yaml
  h_ios 02-ios-add.yaml            # iOS adds Avocado (delivered pre-fault)
  h_droid 03-android-verify-add.yaml

  # Start the fault schedule (toxiproxy + mini-relay behind CHAOS_PORT). It
  # runs its named timeline in the background and restores the link on exit.
  h_start_chaos "$scenario"

  # Honesty oracle: while the fault is live the indicator must not say
  # "Connected". iOS crosses off + re-adds (R1) into the degraded link.
  h_ios chaos-honesty.yaml
  h_ios 04-ios-readd.yaml

  # Let the fault schedule finish + the link restore, then assert convergence:
  # the R1 re-add landed as ONE unchecked qty-1 row on Android (no dup, no
  # resurrection) — the T1 intent set, now proven THROUGH the fault.
  wait "${_CHAOS_PID}" 2>/dev/null || true
  h_droid 05-android-verify-readd.yaml

  h_stop_chaos
done

h_write_report chaos true "${SCENARIOS[@]}"
h_step "PASS — all chaos scenarios converged with honest status"
