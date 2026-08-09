/**
 * Josh Approved typography system.
 *
 * Components reference roles, never raw font family names. If we swap families
 * later, only this file changes.
 */

import { PixelRatio } from 'react-native';

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
 *
 * `fontSize` is left as the literal point value — RN's Text already scales
 * *rendered* fontSize by the OS accessibility font scale on its own
 * (`allowFontScaling` defaults true). A numeric `lineHeight` does NOT get
 * that treatment; left literal it stays pinned to the scale-1.0 pixel value
 * while the glyphs beneath it grow, clipping or overlapping lines at large
 * Dynamic Type sizes. So each step's lineHeight is scaled here, at the one
 * point every consumer reads it from, by the current
 * `PixelRatio.getFontScale()` — a plain getter (not a function call at the
 * use site) so `...type.md` keeps working unchanged everywhere it's spread
 * into a style object, and each read picks up the live OS font scale. At
 * scale 1.0 the values are byte-identical to the original literals.
 */
const typeBase = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 22 },
  md: { fontSize: 20, lineHeight: 28 },
  // Added 2026-08-09. The scale stopped at `md`, so every heading, numeric
  // readout and oversized display string in the fleet — 18/22/24/26/28/32/44pt
  // — was hand-rolled with a literal lineHeight that never scaled. A scale that
  // doesn't reach the sizes apps actually use isn't a scale, it's a suggestion:
  // 64 call sites went around it. These cover the real inventory.
  lg: { fontSize: 24, lineHeight: 30 },
  xl: { fontSize: 28, lineHeight: 34 },
  display: { fontSize: 32, lineHeight: 38 },
  hero: { fontSize: 44, lineHeight: 52 },
} as const;

function scaledStep(step: keyof typeof typeBase) {
  const { fontSize, lineHeight } = typeBase[step];
  return { fontSize, lineHeight: scaledLineHeight(lineHeight) };
}

/**
 * Scale one literal lineHeight by the live OS accessibility font scale.
 *
 * The escape hatch for a call site that genuinely needs leading the `type`
 * scale doesn't offer (a deliberately looser paragraph, a one-off numeric
 * readout). Use it INSTEAD of a bare number:
 *
 *   lineHeight: 24                      // ✗ pinned — clips at large text
 *   lineHeight: scaledLineHeight(24)    // ✓ grows with the OS setting
 *
 * Prefer spreading a `type` step when one fits; this exists so that "no step
 * fits" never again means "write a literal". Enforced by the qa-canonical rule
 * `a11y/scalable-line-height`, which bans a numeric lineHeight outside this
 * file.
 */
export function scaledLineHeight(px: number): number {
  return Math.round(px * PixelRatio.getFontScale());
}

export const type = {
  get xs() {
    return scaledStep('xs');
  },
  get sm() {
    return scaledStep('sm');
  },
  get base() {
    return scaledStep('base');
  },
  get md() {
    return scaledStep('md');
  },
  get lg() {
    return scaledStep('lg');
  },
  get xl() {
    return scaledStep('xl');
  },
  get display() {
    return scaledStep('display');
  },
  get hero() {
    return scaledStep('hero');
  },
};

export type TypeStep = keyof typeof typeBase;

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
