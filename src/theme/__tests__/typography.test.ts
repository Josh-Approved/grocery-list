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
import { type, scaledLineHeight } from '../typography';

const STEPS = ['xs', 'sm', 'base', 'md', 'lg', 'xl', 'display', 'hero'] as const;

// The literal pixel values the scale shipped with — used only to prove scale
// 1.0 is unchanged; not hardcoded as the "correct" answer at other scales.
const BASELINE_AT_SCALE_1: Record<(typeof STEPS)[number], { fontSize: number; lineHeight: number }> = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 22 },
  md: { fontSize: 20, lineHeight: 28 },
  lg: { fontSize: 24, lineHeight: 30 },
  xl: { fontSize: 28, lineHeight: 34 },
  display: { fontSize: 32, lineHeight: 38 },
  hero: { fontSize: 44, lineHeight: 52 },
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

  it('never lets leading fall below the glyph size it has to hold', () => {
    // The failure users actually see is lines colliding: leading shorter than
    // the rendered font. RN scales fontSize itself, so a step is only safe if
    // its scaled lineHeight still clears its scaled fontSize at every size.
    for (const scale of [1, 1.5, 2, 3.5]) {
      jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(scale);
      for (const step of STEPS) {
        const renderedFontSize = BASELINE_AT_SCALE_1[step].fontSize * scale;
        expect(type[step].lineHeight).toBeGreaterThanOrEqual(renderedFontSize);
      }
      jest.restoreAllMocks();
    }
  });
});

describe('scaledLineHeight — the escape hatch for one-off leading', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is identity at font scale 1.0, so nothing moves for default-size users', () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
    for (const px of [16, 20, 22, 24, 34, 52]) {
      expect(scaledLineHeight(px)).toBe(px);
    }
  });

  it('tracks the OS font scale', () => {
    for (const scale of [1.5, 2, 3.5]) {
      jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(scale);
      expect(scaledLineHeight(20)).toBe(Math.round(20 * scale));
      jest.restoreAllMocks();
    }
  });

  it('is what a literal is not — a bare number stays pinned while glyphs grow', () => {
    // This is the whole defect, stated as a test: at AX sizes a literal 20 is
    // still 20 while the text it holds has grown past it.
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(3.5);
    const literal = 20;
    expect(scaledLineHeight(20)).toBeGreaterThan(literal);
  });
});
