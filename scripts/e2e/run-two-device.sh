#!/usr/bin/env bash
# Two-device (iOS simulator + Android emulator) live sync E2E.
#
# Proves the 2026-07-03 reported defects are fixed ON DEVICE, over the real
# transport/crypto/engine, against a hermetic local relay:
#   - cross-platform propagation (add on iOS → appears on Android)
#   - R1: re-add of a crossed-off item stays quantity 1, unchecked, ONE row
#   - R2: a check-off survives a blind concurrent quantity edit made on the
#     other device while it was OFFLINE (both edits win after reconnect)
#   - cold-start hello backfill after the app is killed
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

IOS_UDID="${1:?usage: run-two-device.sh <ios-sim-udid> [android-serial]}"
ANDROID="${2:-emulator-5554}"
APP_ID="com.joshapproved.grocerylist"
FLOWS="$(cd "$(dirname "$0")/../../qa/flows/e2e-sync" && pwd)"

step() { printf '\n=== %s ===\n' "$*"; }
ios() { maestro --device "$IOS_UDID" test "$FLOWS/$1"; }
droid() { maestro --device "$ANDROID" test "$FLOWS/$1"; }

step "0/8 Reset both devices"
# Kill the iOS app FIRST: a leftover instance from a prior run would answer
# Android's hello and pollute the fresh baseline within seconds.
xcrun simctl terminate "$IOS_UDID" "$APP_ID" 2>/dev/null || true
# NOT Maestro clearState: on Android, the first launch right after `pm clear`
# races expo-sqlite's directory creation ("path already points to a non-normal
# file"), hydrate fails, and the QA fixtures never seed. A reinstall plus one
# warm-up launch (creates the DB, seeds fixtures) then force-stop gives flow 01
# a fresh-but-healthy state to relaunch into.
adb -s "$ANDROID" uninstall "$APP_ID" >/dev/null 2>&1 || true
adb -s "$ANDROID" install -r "$(dirname "$0")/../../android/app/build/outputs/apk/debug/app-debug.apk" >/dev/null
adb -s "$ANDROID" shell am start -n "$APP_ID/.MainActivity" >/dev/null
sleep 20
adb -s "$ANDROID" shell am force-stop "$APP_ID"
# Second warm-up: the first launch after a fresh install can race SQLite
# directory creation (retried in-app now, but belt + suspenders here).
adb -s "$ANDROID" shell am start -n "$APP_ID/.MainActivity" >/dev/null
sleep 10
adb -s "$ANDROID" shell am force-stop "$APP_ID"

step "1/8 Android: fresh boot, open shared list (baseline)"
droid 01-android-open.yaml

step "2/8 iOS: fresh boot, add Avocado"
ios 02-ios-add.yaml

step "3/8 Android: Avocado arrived live"
droid 03-android-verify-add.yaml

step "4/8 iOS: cross off + re-add → qty 1, unchecked (R1)"
ios 04-ios-readd.yaml
droid 05-android-verify-readd.yaml

step "5/8 Android OFFLINE; iOS checks Bananas"
adb -s "$ANDROID" shell svc wifi disable
adb -s "$ANDROID" shell svc data disable
ios 06-ios-check-bananas.yaml

step "6/8 Android (offline): blind quantity bump on Bananas"
droid 07-android-bump-bananas.yaml

step "7/8 Reconnect → BOTH edits survive (R2)"
adb -s "$ANDROID" shell svc wifi enable
adb -s "$ANDROID" shell svc data enable
droid 08-android-verify-merge.yaml
ios 09-ios-verify-merge.yaml

step "8/8 Kill iOS; Android adds Mango; relaunch iOS → backfill"
xcrun simctl terminate "$IOS_UDID" "$APP_ID" || true
droid 10-android-add-mango.yaml
ios 11-ios-verify-backfill.yaml

step "PASS — all two-device sync scenarios green"
