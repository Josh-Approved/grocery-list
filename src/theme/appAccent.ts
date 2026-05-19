/**
 * Per-app brand accent — the ONE additional color this app declares
 * (progress fills, the app-icon glyph). In-app only: never a primary CTA,
 * never replaces approval green, never on marketing surfaces.
 *
 * APP-OWNED. `sync.mjs design-system-native` created this once and never
 * overwrites it. Edit the hex here; colors.ts derives the light/dark washes.
 *
 * PROVISIONAL. The final accent + the app-icon glyph are an explicit open
 * decision owned by Josh/design — see josh-approved-factory/candidates/
 * grocery-list/spec.md § Open decisions (#5), resolved at build step 6.
 * This is a calm, earthy, grocery-evoking placeholder so the app has an
 * identity during the build; it is not the committed brand decision.
 */

export const APP_ACCENT = '#8A6A45'; // provisional — warm "market kraft" brown
