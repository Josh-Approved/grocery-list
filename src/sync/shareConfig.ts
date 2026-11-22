/**
 * Per-app share-link scheme. App-owned — the factory's `shared-sync` module
 * syncs this file only if absent, so this value survives every re-sync.
 *
 * Must match `expo.scheme` in `app.json`. iOS's `Info.plist`
 * `CFBundleURLSchemes` must include it too (Expo prebuild does this from
 * `expo.scheme`).
 */

export const SHARE_SCHEME = 'grocerylist';

/**
 * Web base for share links. Invites go out as
 * https://joshapproved.com/join/grocery-list/#?s=<secret>, which WhatsApp and
 * every other chat app make tappable (they ignore `grocerylist://` links). The
 * link opens the app directly when it's installed, and the joshapproved.com
 * invite page with the store buttons when it isn't. Requires the site's
 * association files, app.json associatedDomains + intentFilters, and the iOS
 * Associated Domains capability: see the factory shared-sync README.
 */
export const SHARE_WEB_URL: string | null =
  'https://joshapproved.com/join/grocery-list/';
