/**
 * Josh Approved typography system.
 *
 * Components reference roles, never raw font family names. If we swap families
 * later, only this file changes.
 */

export const fontFamilies = {
  'IBMPlexSans-Regular': 'IBMPlexSans-Regular',
  'IBMPlexSans-Medium': 'IBMPlexSans-Medium',
  'IBMPlexSans-SemiBold': 'IBMPlexSans-SemiBold',
  'IBMPlexMono-Regular': 'IBMPlexMono-Regular',
  'IBMPlexMono-Medium': 'IBMPlexMono-Medium',
} as const;

export type FontFamily = keyof typeof fontFamilies;

export const typography = {
  body: fontFamilies['IBMPlexSans-Regular'],
  bodyEmphasis: fontFamilies['IBMPlexSans-Medium'],
  heading: fontFamilies['IBMPlexSans-SemiBold'],
  mono: fontFamilies['IBMPlexMono-Regular'],
  monoEmphasis: fontFamilies['IBMPlexMono-Medium'],
} as const;

export type TypographyRole = keyof typeof typography;

/**
 * Weight-named family aliases. Prefer `typography` roles in app code; this
 * map exists for shared components (canonical ReviewModal, Credits) that
 * think in "sans / sans-semibold / mono" rather than role names.
 */
export const fontFamily = {
  sans: fontFamilies['IBMPlexSans-Regular'],
  sansMedium: fontFamilies['IBMPlexSans-Medium'],
  sansSemibold: fontFamilies['IBMPlexSans-SemiBold'],
  mono: fontFamilies['IBMPlexMono-Regular'],
  monoMedium: fontFamilies['IBMPlexMono-Medium'],
} as const;

/**
 * Type scale — { fontSize, lineHeight } pairs spread into a Text style.
 * Covers the steps shared components need (xs..md). App screens may still
 * inline sizes; this is the shared-component contract.
 */
export const type = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 22 },
  md: { fontSize: 20, lineHeight: 28 },
} as const;

export type TypeStep = keyof typeof type;

/**
 * Letter-spacing scale, in React Native points (RN has no `em`). Approximates
 * the canonical em tracking from colors_and_type.css: tight ≈ -0.02em,
 * wide ≈ +0.02em, mark ≈ -0.03em. `wide` is the uppercase-label value apps
 * already use inline (0.5).
 */
export const tracking = {
  tight: -0.3,
  normal: 0,
  wide: 0.5,
  mark: -0.5,
} as const;

export type Tracking = keyof typeof tracking;
