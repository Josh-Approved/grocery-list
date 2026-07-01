/**
 * Device + app environment snapshot for a feedback report — the "environment"
 * a good bug report needs (canon § Funding & feedback; the standard good-bug
 * checklist: app version, build, OS, device). Read on demand when the user files
 * feedback; never collected in the background.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * This is device metadata the user can see and chooses to send — not user data
 * and not telemetry (canon § Privacy & data: device/version info the user
 * includes when filing feedback is the sanctioned case).
 *
 * IMPORTANT (React Native / Metro): every dependency here is a STATIC import of a
 * module the feedback flow REQUIRES (expo-application + expo-device, installed
 * alongside expo-mail-composer). A dynamic `require(variable)` does not bundle.
 */

import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { getLocale } from '../i18n';

export type Diagnostics = {
  app: string;
  version: string; // "1.2.0 (47)"
  platform: 'iOS' | 'Android' | string;
  osVersion: string;
  device: string;
  locale: string;
  when: string; // ISO timestamp
};

/** The app's display name (from the native bundle) without the " - Josh Approved"
 *  identity suffix, for a tidy subject line. */
export function shortAppName(): string {
  const raw = (Application.applicationName || '').trim();
  return raw.replace(/\s*-\s*Josh Approved\s*$/i, '').trim() || raw || 'App';
}

/** "1.2.0 (47)" read from the native bundle; "unknown" if unavailable. */
function appVersion(): string {
  const v = Application.nativeApplicationVersion || '';
  const b = Application.nativeBuildVersion || '';
  if (!v) return 'unknown';
  return b ? `${v} (${b})` : v;
}

/** Device model via expo-device; a neutral placeholder if it can't be read. */
function deviceModel(): string {
  const name = Device.modelName || Device.deviceName;
  return name ? String(name) : 'unknown device';
}

export function collectDiagnostics(): Diagnostics {
  const platform = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS;
  return {
    app: shortAppName(),
    version: appVersion(),
    platform,
    osVersion: String(Platform.Version),
    device: deviceModel(),
    locale: getLocale(),
    when: new Date().toISOString(),
  };
}

/** A compact, human-readable environment block for the email body. */
export function formatDiagnostics(d: Diagnostics): string {
  return [
    `App:     ${d.app} ${d.version}`,
    `Device:  ${d.device} (${d.platform} ${d.osVersion})`,
    `Locale:  ${d.locale}`,
    `When:    ${d.when}`,
  ].join('\n');
}
