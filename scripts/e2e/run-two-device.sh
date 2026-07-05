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
#
# The device-reset + per-device Maestro helpers now live in the factory-shared
# scripts/e2e/harness-lib.sh (module: e2e-two-device); this script is the
# app-owned ORCHESTRATION (grocery's own 11-flow sequence + offline windows).
#
# Prerequisites (the session that authored this ran them by hand):
#   - mini-relay:  node scripts/e2e/mini-relay.mjs --port 7447
#   - Metro:       EXPO_PUBLIC_SYNC_RELAYS="ws://127.0.0.1:7447,ws://10.0.2.2:7447" \
#                  EXPO_PUBLIC_QA_MODE=1 EXPO_PUBLIC_QA_SHARE_SECRET=<base64-32B> \
#                  npx expo start --port 8081
#   - Debug app installed on both: npx expo run:ios / run:android --no-bundler
#
# Usage: scripts/e2e/run-two-device.sh <ios-sim-udid> [android-serial]
# Maestro drives ONE device at a time (two concurrent drivers destabilise RN).
set -euo pipefail

E2E_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_UDID="${1:?usage: run-two-device.sh <ios-sim-udid> [android-serial]}"
ANDROID_SERIAL="${2:-emulator-5554}"
# shellcheck source=/dev/null
source "$E2E_DIR/e2e.config.sh"
# shellcheck source=/dev/null
source "$E2E_DIR/harness-lib.sh"

h_step "0/8 Reset both devices"
# Kill the iOS app FIRST: a leftover instance from a prior run would answer
# Android's hello and pollute the fresh baseline within seconds.
h_ios_terminate
# Reinstall + warm-up (NOT Maestro clearState / pm clear — that races
# expo-sqlite's first-launch directory creation so fixtures never seed).
h_reset_android

h_step "1/8 Android: fresh boot, open shared list (baseline)"
h_droid 01-android-open.yaml

h_step "2/8 iOS: fresh boot, add Avocado"
h_ios 02-ios-add.yaml

h_step "3/8 Android: Avocado arrived live"
h_droid 03-android-verify-add.yaml

h_step "4/8 iOS: cross off + re-add → qty 1, unchecked (R1)"
h_ios 04-ios-readd.yaml
h_droid 05-android-verify-readd.yaml

h_step "5/8 Android OFFLINE; iOS checks Bananas"
h_android_offline
h_ios 06-ios-check-bananas.yaml

h_step "6/8 Android (offline): blind quantity bump on Bananas"
h_droid 07-android-bump-bananas.yaml

h_step "7/8 Reconnect → BOTH edits survive (R2)"
h_android_online
h_droid 08-android-verify-merge.yaml
h_ios 09-ios-verify-merge.yaml

h_step "8/8 Kill iOS; Android adds Mango; relaunch iOS → backfill"
h_ios_terminate
h_droid 10-android-add-mango.yaml
h_ios 11-ios-verify-backfill.yaml

h_write_report baseline true two-device-baseline
h_step "PASS — all two-device sync scenarios green"
