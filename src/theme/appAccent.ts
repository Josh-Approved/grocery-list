/**
 * Per-app brand accent — the ONE additional color this app declares
 * (progress fills, the app-icon glyph). In-app only: never a primary CTA,
 * never replaces approval green, never on marketing surfaces.
 *
 * APP-OWNED. `sync.mjs design-system-native` created this once and never
 * overwrites it. Edit the hex here; colors.ts derives the light/dark washes.
 *
 * DECIDED: Josh picked candidate C (aubergine) from the 2026-06-10 icon kit
 * on 2026-06-11 — this is the committed brand accent.
 */

export const APP_ACCENT = '#6E4A63'; // aubergine — decided 2026-06-11 (icon-kit candidate C)
