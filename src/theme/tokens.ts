/**
 * Spacing, radius, target, motion, and hairline tokens (React Native).
 *
 * Canonical mirror of josh-approved-design-system/colors_and_type.css. Synced
 * into each app at src/theme/tokens.ts by `sync.mjs design-system-native`.
 * Edit values HERE, not per app.
 */

import { StyleSheet } from 'react-native';

// ---------- Spacing (4pt grid) ----------
export const space = {
  s0: 0,
  s1: 2,
  s2: 4,
  s3: 8,
  s4: 12,
  s5: 16,
  s6: 24,
  s7: 32,
  s8: 48,
  s9: 64,
} as const;

// ---------- Radius ----------
export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 22,    // iOS app icon native
  pill: 999,
} as const;

// ---------- Touch targets (44pt iOS, 48pt Android, use 44 floor) ----------
export const target = {
  ios: 44,
  android: 48,
  min: 44,
} as const;

// ---------- Motion ----------
// Single ease-out curve. No bounces. Reduce-motion observers should collapse
// these to 0; do that at the call site (RN doesn't expose prefersReducedMotion
// natively, so check via `AccessibilityInfo.isReduceMotionEnabled()`).
export const motion = {
  durationInstant: 0,
  durationFast: 150,
  durationSlow: 250,
  easingStandard: [0.2, 0, 0, 1] as readonly [number, number, number, number],
} as const;

// ---------- Hairline ----------
// The 1px (sub-pixel on retina) border width the system uses instead of
// shadows. A primitive, not a color — the hairline *color* is in colors.ts.
export const hairline = StyleSheet.hairlineWidth;
