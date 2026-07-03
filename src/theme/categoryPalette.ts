/**
 * Canonical in-app categorical palette — the studio-wide set of distinguishable
 * hues for any product surface that needs a *set* of colors (category dots, a
 * breakdown chart, per-account tints, tag colors).
 *
 * Ratified studio-wide 2026-06-13 (from budget's first data-viz surface;
 * `/reconcile-canon` audit budget-20260612-1) and documented in the design-
 * system skill § Color. The Josh Approved product UI otherwise ships only
 * ink + paper + approval-green + one per-app accent; these twelve muted,
 * aged-pigment hues stay inside that register (desaturated, paper-friendly,
 * none competing with or reading as approval green).
 *
 * Tokens are stable string ids ('cat-1'…'cat-12') stored on each record so a
 * recolor is data, not a hardcoded hex, and a future palette swap is one edit.
 *
 * Synced into apps at src/theme/categoryPalette.ts by `sync.mjs
 * design-system-native` **ifAbsent** — an app that has already customized its
 * palette (e.g. budget, the source) is never clobbered. Edit the canonical
 * file here, not per app.
 */

export const CATEGORY_COLORS: Record<string, string> = {
  'cat-1': '#B0654B', // terracotta
  'cat-2': '#A8842F', // ochre
  'cat-3': '#7C8A4E', // olive
  'cat-4': '#4E8F8F', // teal
  'cat-5': '#5E7691', // dusty blue
  'cat-6': '#5C5F94', // slate indigo
  'cat-7': '#7E5685', // muted plum
  'cat-8': '#A85A74', // dusty rose
  'cat-9': '#8A6A52', // clay brown
  'cat-10': '#426079', // deep blue
  'cat-11': '#7C7A78', // warm gray
  'cat-12': '#5F8A6B', // moss
};

export const CATEGORY_COLOR_TOKENS = Object.keys(CATEGORY_COLORS);

/** Resolve a color token to its hex; an unknown token degrades to the first
 *  swatch rather than crashing. */
export function categoryColor(token: string): string {
  return CATEGORY_COLORS[token] ?? CATEGORY_COLORS['cat-1'];
}
