/**
 * Dynamic Type regression guard for the shared type scale.
 *
 * Synced verbatim into each app at src/theme/__tests__/typography.test.ts by
 * `sync.mjs design-system-native`. Edit the canonical file in
 * josh-approved-factory/templates/design-system/__tests__/, not per app.
 *
 * React Native auto-scales `fontSize` by the OS accessibility font scale
 * (`allowFontScaling` defaults true) but does NOT auto-scale a numeric
 * `lineHeight` — a fixed lineHeight paired with a scaling fontSize clips or
 * overlaps text at large accessibility sizes. This guards that every step of
 * the shared `type` scale grows its lineHeight with the current font scale,
 * and that at scale 1.0 it still renders the original literal values (no
 * visual change for users at the default size).
 */
import { PixelRatio } from 'react-native';
import { type } from '../typography';

const STEPS = ['xs', 'sm', 'base', 'md'] as const;

// The literal pixel values the scale shipped with — used only to prove scale
// 1.0 is unchanged; not hardcoded as the "correct" answer at other scales.
const BASELINE_AT_SCALE_1: Record<(typeof STEPS)[number], { fontSize: number; lineHeight: number }> = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 22 },
  md: { fontSize: 20, lineHeight: 28 },
};

describe('type scale — Dynamic Type lineHeight', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders the original literal fontSize/lineHeight at font scale 1.0', () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
    for (const step of STEPS) {
      expect(type[step].fontSize).toBe(BASELINE_AT_SCALE_1[step].fontSize);
      expect(type[step].lineHeight).toBe(BASELINE_AT_SCALE_1[step].lineHeight);
    }
  });

  it('grows lineHeight proportionally with the OS font scale, for every step', () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    for (const step of STEPS) {
      const base = BASELINE_AT_SCALE_1[step];
      // lineHeight must scale with the font, not stay pinned to the
      // scale-1.0 literal — otherwise large Dynamic Type clips/overlaps.
      expect(type[step].lineHeight).toBeGreaterThan(base.lineHeight);
      // And it should track the scale factor (allow rounding slack).
      expect(type[step].lineHeight).toBeCloseTo(base.lineHeight * 2, 0);
    }
  });

  it('scales lineHeight at an accessibility XXXL-ish factor (3.5x) too', () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(3.5);
    for (const step of STEPS) {
      const base = BASELINE_AT_SCALE_1[step];
      expect(type[step].lineHeight).toBeCloseTo(base.lineHeight * 3.5, 0);
    }
  });
});
