/**
 * Dark-mode contrast contract — guards the canonical theme tokens.
 *
 * Synced verbatim into each app at src/theme/__tests__/contrast.test.ts by
 * `sync.mjs design-system-native`. Edit the canonical file in
 * josh-approved-factory/templates/design-system/__tests__/, not per app.
 *
 * The OS-following palettes INVERT in dark mode, so a foreground must pair with
 * the token that inverts WITH its background. This test locks the matched pairs
 * (so a future palette edit can't silently break contrast) and pins the trap
 * that shipped a real defect: `fgOnInk` is paper in BOTH palettes, so it
 * collapses to ~1:1 on the inverted dark-mode ink button — the correct token is
 * `inkButtonText`. Component-level misuse of `fgOnInk` is caught by the
 * `theme/contrast-pairing` QA-linter rule; this guards the token definitions.
 */
import { lightColors, darkColors, type Colors } from '../colors';

function rgb(input: string): [number, number, number] {
  const m = input.trim().match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const h = m[1];
    return [0, 2, 4].map((o) => parseInt(h.substr(o, 2), 16)) as [number, number, number];
  }
  const r = input.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (r) return [Number(r[1]), Number(r[2]), Number(r[3])];
  throw new Error(`unparseable color: ${input}`);
}
function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Pair = { bg: keyof Colors; fg: keyof Colors; min: number };

// Foreground/background pairs that are rendered together and must stay legible
// in BOTH palettes. Thresholds sit comfortably below today's measured ratios so
// the test passes now but trips on a real regression.
const TEXT_PAIRS: Pair[] = [
  { bg: 'inkButton', fg: 'inkButtonText', min: 7 }, // primary CTA (ReviewModal etc.)
  { bg: 'fg', fg: 'bg', min: 7 }, // inverted pill / segmented-control active state
  { bg: 'bg', fg: 'fg', min: 7 }, // body text on the screen
  { bg: 'bgElevated', fg: 'fg', min: 7 }, // body text on a card
  { bg: 'bgSubtle', fg: 'fg', min: 7 }, // body text on a subtle fill
  { bg: 'bg', fg: 'fgMuted', min: 4.5 }, // secondary text (AA)
  { bg: 'bgElevated', fg: 'fgMuted', min: 4.5 },
];

// Graphical/icon pair — the white check on the green "done" box. Held to the
// WCAG bar for graphical objects (3:1), not the 4.5:1 text bar.
const GRAPHICAL_PAIRS: Pair[] = [{ bg: 'accent', fg: 'fgOnAccent', min: 3 }];

describe('theme contrast (both palettes)', () => {
  for (const [name, palette] of [['light', lightColors], ['dark', darkColors]] as const) {
    describe(name, () => {
      for (const { bg, fg, min } of [...TEXT_PAIRS, ...GRAPHICAL_PAIRS]) {
        it(`${String(bg)} ↔ ${String(fg)} ≥ ${min}:1`, () => {
          const r = contrast(palette[bg] as string, palette[fg] as string);
          expect(r).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  // The trap, pinned: `fgOnInk` is the WRONG token for the ink button because it
  // does not invert — it collapses on the dark-mode (light) button. The correct
  // inverting partner is `inkButtonText`. If a future edit makes `fgOnInk`
  // invert (so this guard fails), delete `fgOnInk` and use `inkButtonText`.
  it('inkButtonText (not fgOnInk) is the ink button’s inverting partner', () => {
    expect(contrast(darkColors.inkButton, darkColors.inkButtonText)).toBeGreaterThanOrEqual(7);
    expect(contrast(darkColors.inkButton, darkColors.fgOnInk)).toBeLessThan(3);
  });
});
