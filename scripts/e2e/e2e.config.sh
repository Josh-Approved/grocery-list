#!/usr/bin/env bash
# Per-app config for the two-device sync E2E. APP-OWNED (synced ifAbsent — never
# clobbered on re-sync, same as src/sync/shareConfig.ts). Fill the CHANGE_ME
# values for this app; the shared harness-lib.sh reads them.
#
# Sourced by run-two-device.sh / run-chaos.sh.

# This app's iOS + Android bundle id.
APP_ID="com.joshapproved.grocerylist"

# Debug APK the Android reset installs (relative to the app repo root).
ANDROID_APK="android/app/build/outputs/apk/debug/app-debug.apk"

# Absolute dir of this app's Maestro sync flows (set at source time).
FLOWS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../qa/flows/e2e-sync" && pwd)"

# Ports: mini-relay (hermetic, internal) + toxiproxy chaos front-end.
RELAY_PORT="${RELAY_PORT:-7447}"
CHAOS_PORT="${CHAOS_PORT:-7448}"
