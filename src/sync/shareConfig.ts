/**
 * Per-app share-link scheme. App-owned — the factory's `shared-sync` module
 * syncs this file only if absent, so this value survives every re-sync.
 *
 * Must match `expo.scheme` in `app.json`. iOS's `Info.plist`
 * `CFBundleURLSchemes` must include it too (Expo prebuild does this from
 * `expo.scheme`).
 */

export const SHARE_SCHEME = 'grocerylist';
