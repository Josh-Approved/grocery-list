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
 * includes when filing feedback is the sanctioned case). Every native source is
 * resolved DEFENSIVELY (optional require) so the snapshot degrades to a
 * placeholder rather than crashing in an app that lacks a given module or reads
 * its version a different way.
 */

import { Platform } from 'react-native';
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

/** Optional native module — required only here, resolved without a static import
 *  so a missing dependency degrades instead of breaking the build/runtime. */
function opt(mod: string): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(mod);
  } catch {
    return null;
  }
}

/** App name + "version (build)" from whatever the app happens to ship — prefers
 *  expo-application, falls back to expo-constants, then a placeholder. */
function appMeta(): { name: string; version: string } {
  const App = opt('expo-application');
  const Constants = opt('expo-constants');
  const name =
    (App && App.applicationName) || (Constants && Constants.expoConfig && Constants.expoConfig.name) || 'App';
  let version = '';
  if (App) {
    const v = App.nativeApplicationVersion;
    const b = App.nativeBuildVersion;
    if (v) version = b ? `${v} (${b})` : String(v);
  }
  if (!version && Constants && Constants.expoConfig && Constants.expoConfig.version) {
    version = String(Constants.expoConfig.version);
  }
  return { name: String(name), version: version || 'unknown' };
}

/** The app's display name without the " - Josh Approved" identity suffix. */
export function shortAppName(): string {
  const raw = appMeta().name.trim();
  return raw.replace(/\s*-\s*Josh Approved\s*$/i, '').trim() || raw || 'App';
}

/** Device model via expo-device when present; a neutral placeholder otherwise. */
function deviceModel(): string {
  const Device = opt('expo-device');
  if (Device) {
    const name = Device.modelName || Device.deviceName;
    if (name) return String(name);
  }
  return 'unknown device';
}

export function collectDiagnostics(): Diagnostics {
  const platform = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS;
  const meta = appMeta();
  return {
    app: meta.name.replace(/\s*-\s*Josh Approved\s*$/i, '').trim() || 'App',
    version: meta.version,
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
