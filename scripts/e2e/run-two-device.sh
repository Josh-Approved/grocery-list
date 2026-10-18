#!/usr/bin/env bash
# Two-device (iOS simulator + Android emulator) live sync E2E — BASELINE.
#
# Proves the 2026-07-03 reported defects are fixed ON DEVICE, over the real
# transport/crypto/engine, against a hermetic local relay:
#   - cross-platform propagation (add on iOS → appears on Android)
#   - R1: re-add of a crossed-off item stays quantity 1, unchecked, ONE row
#   - R2: a check-off survives a blind concurrent quantity edit made on the
#     other device while it was OFFLINE (both edits win after reconnect)
#   - cold-start hello backfill after the app is killed
#   - STORE-AND-FORWARD (defect grocery-list-20261018-1): an edit made while the
#     partner is KILLED reaches it when it relaunches ALONE — the editor is
#     killed too, so no live hello can answer; only the drop-box deposit can
#
# The device-reset + per-device Maestro helpers now live in the factory-shared
# scripts/e2e/harness-lib.sh (module: e2e-two-device); this script is the
# app-owned ORCHESTRATION (grocery's own 13-flow sequence + offline windows).
#
# Prerequisites (the session that authored this ran them by hand):
#   - mini-relay:  started FRESH by this script (h_fresh_relay) — do not run one
#                  by hand; a relay left over from a previous run still holds
#                  that run's deposits and poisons the fresh baseline.
#   - Metro:       EXPO_PUBLIC_SYNC_RELAYS="ws://127.0.0.1:7447,ws://10.0.2.2:7447" \
#                  EXPO_PUBLIC_QA_MODE=1 EXPO_PUBLIC_QA_SHARE_SECRET=<base64-32B> \
#                  npx expo start --port 8081 --clear
#     --clear IS NOT OPTIONAL. Metro caches the transformed bundle, and a cached
#     bundle from an earlier non-QA start has EXPO_PUBLIC_QA_MODE inlined as
#     absent — the app then boots to an EMPTY list with no fixtures and the
#     suite fails on its first assertion, which reads exactly like a sync
#     defect. Confirm inlining before running: fetch the bundle and grep for
#     the share secret, the relay URL and QA_MODE. (Cost a wasted run 2026-08-25.)
#   - Debug app installed on both: npx expo run:ios / run:android --no-bundler
#     `run:android --device` wants the AVD NAME (e.g. aosp_nogms), NOT the adb
#     serial (emulator-5554) — it rejects the serial outright. The serial is what
#     THIS script takes as arg 2; they are different identifiers for the same
#     emulator and swapping them is a silent time sink. `emulator -list-avds`
#     gives the names, `adb devices` gives the serials.
#   - The emulator's radios must actually be UP. A run that dies inside an
#     offline window leaves wlan0/eth0 DOWN and poisons the NEXT run, which then
#     fails at phase 1's "Connected" and reads exactly like a sync bug. The
#     harness repairs and then ASSERTS this (h_assert_android_online), so a dead
#     radio now names itself instead of costing a run — but if you are driving
#     the emulator by hand, restore it yourself:
#       adb -s <serial> shell svc wifi enable && adb -s <serial> shell svc data enable
#
# Usage: scripts/e2e/run-two-device.sh <ios-sim-udid> [android-serial]
# Maestro drives ONE device at a time (two concurrent drivers destabilise RN).
set -euo pipefail

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Mac-mini load governor (Uplevel 3 / T5) ──────────────────────────────────
# This two-device run (two device drivers + Metro) is ONE heavy unit; on the 8 GB
# mini heavy work must run one-at-a-time. Re-exec the whole script under the
# factory's machine-wide heavy-lock CLI shim (a no-op on a full-size machine).
# JA_HEAVY_HELD is set once we're inside the lock, so this fires exactly once. If
# the factory sibling isn't present (app repo cloned alone) we run unguarded —
# the lock only matters on the mini, where the factory is always a sibling.
if [ -z "${JA_HEAVY_HELD:-}" ]; then
  _JA_HEAVY="$E2E_DIR/../../../josh-approved-factory/scripts/lib/heavy.mjs"
  if [ -f "$_JA_HEAVY" ]; then
    _JA_APP="$(basename "$(cd "$E2E_DIR/../.." && pwd)")"
    exec node "$_JA_HEAVY" run --label "e2e:$_JA_APP" -- "$0" "$@"
  fi
fi

IOS_UDID="${1:?usage: run-two-device.sh <ios-sim-udid> [android-serial]}"
ANDROID_SERIAL="${2:-emulator-5554}"
# shellcheck source=/dev/null
source "$E2E_DIR/e2e.config.sh"
# shellcheck source=/dev/null
source "$E2E_DIR/harness-lib.sh"

h_step "0/9 Fresh relay; reset both devices"
# The run owns its relay: an EMPTY drop box, stopped on exit. A relay carried
# over from an earlier run would hand the "fresh" devices that run's end state
# (store-and-forward keeps every device's latest deposit — see h_fresh_relay).
h_fresh_relay
trap 'h_stop_relay; h_android_online_safe' EXIT
# Kill the iOS app FIRST: a leftover instance from a prior run would answer
# Android's hello and pollute the fresh baseline within seconds.
h_ios_terminate
# Reinstall + warm-up (NOT Maestro clearState / pm clear — that races
# expo-sqlite's first-launch directory creation so fixtures never seed).
h_reset_android

h_step "1/9 Android: fresh boot, open shared list (baseline)"
h_droid 01-android-open.yaml

h_step "2/9 iOS: fresh boot, add Avocado"
h_ios 02-ios-add.yaml

h_step "3/9 Android: Avocado arrived live"
h_droid 03-android-verify-add.yaml

h_step "4/9 iOS: cross off + re-add → qty 1, unchecked (R1)"
h_ios 04-ios-readd.yaml
h_droid 05-android-verify-readd.yaml

h_step "5/9 Android OFFLINE; iOS checks Bananas"
h_android_offline
h_ios 06-ios-check-bananas.yaml

h_step "6/9 Android (offline): blind quantity bump on Bananas"
h_droid 07-android-bump-bananas.yaml

h_step "7/9 Reconnect → BOTH edits survive (R2)"
h_android_online
h_droid 08-android-verify-merge.yaml
h_ios 09-ios-verify-merge.yaml

h_step "8/9 Kill iOS; Android adds Mango; relaunch iOS → backfill"
h_ios_terminate
h_droid 10-android-add-mango.yaml
h_ios 11-ios-verify-backfill.yaml

# The reported defect (grocery-list-20261018-1): before store-and-forward this
# phase could only pass if both apps were open together. Android is KILLED
# before iOS edits, iOS is KILLED before Android relaunches, so nothing live
# can carry the edit — only the deposit the relay kept.
h_step "9/9 Kill Android; iOS adds Papaya; kill iOS; relaunch Android ALONE → has Papaya"
h_android_terminate
h_ios 12-ios-add-papaya.yaml
h_ios_terminate
h_droid 13-android-verify-stored.yaml

h_write_report baseline true two-device-baseline
h_step "PASS — all two-device sync scenarios green"
