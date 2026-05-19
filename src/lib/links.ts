/**
 * Canonical external links + the version string. One place so the Settings
 * row and the review modal stay identical (canon § Settings / About).
 */

import { Linking, Platform } from 'react-native';
import * as Application from 'expo-application';

export const APP_NAME = 'Grocery List - Josh Approved';

/** Numeric App Store Connect id — filled once the ASC record exists (store
 *  setup). Empty is the known pre-store state; the review deep link no-ops
 *  cleanly until then (same posture as other Josh Approved apps). */
export const IOS_APP_STORE_ID = '';
export const ANDROID_PACKAGE = 'com.joshapproved.grocerylist';

export const BMAC_URL = 'https://buymeacoffee.com/jtysonwilliams';
export const STUDIO_URL = 'https://joshapproved.com';
export const REPO_URL = 'https://github.com/josh-approved/grocery-list';
export const PRIVACY_URL =
  'https://github.com/josh-approved/grocery-list/blob/master/PRIVACY.md';

/** `1.2.0 (47)` — read from the bundle at runtime, never hardcoded. */
export function versionLabel(): string {
  const v = Application.nativeApplicationVersion ?? '1.0.0';
  const b = Application.nativeBuildVersion ?? '1';
  return `${v} (${b})`;
}

export function openUrl(url: string): void {
  Linking.openURL(url).catch(() => {});
}

export function openFeedbackMail(): void {
  const subject = encodeURIComponent(`${APP_NAME} ${versionLabel()}`);
  openUrl(`mailto:feedback@joshapproved.com?subject=${subject}`);
}

export function openReview(): void {
  const url =
    Platform.OS === 'ios'
      ? `itms-apps://itunes.apple.com/app/id${IOS_APP_STORE_ID}?action=write-review`
      : `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}&showAllReviews=true`;
  openUrl(url);
}
