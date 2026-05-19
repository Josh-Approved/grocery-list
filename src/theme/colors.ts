/**
 * Josh Approved color tokens (React Native).
 *
 * Canonical mirror of josh-approved-design-system/colors_and_type.css. Synced
 * into each app at src/theme/colors.ts by `sync.mjs design-system-native`.
 * Edit values HERE, not per app — drift shows up as a sync diff.
 *
 * The one per-app value, the brand accent, is NOT in this file: it lives in
 * the app-owned ./appAccent.ts (which sync never overwrites). This file
 * derives the light/dark accent washes from that single declared hex.
 */

import { useColorScheme } from 'react-native';
import { APP_ACCENT } from './appAccent';

/** #RGB or #RRGGBB -> "rgba(r, g, b, a)". Falls back to the input on a
 *  malformed hex so a bad per-app accent degrades visibly, not silently. */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const appAccent = APP_ACCENT;
export const appAccentBg = hexToRgba(APP_ACCENT, 0.14); // light wash

// ---------- Light palette (canonical) ----------
const light = {
  // Backgrounds
  bg: '#FAFAF7',           // paper — default background
  bgElevated: '#FFFFFF',   // pure white — cards on paper
  bgSubtle: '#F2F2EE',     // ink-50 — subtle fill
  bgScrim: 'rgba(14, 14, 15, 0.5)',

  // Foregrounds
  fg: '#0E0E0F',           // ink-1000 — primary text
  fgMuted: '#6B6B72',      // ink-500 — secondary text
  fgSubtle: '#9A9AA0',     // ink-300 — tertiary, captions, disabled
  fgOnInk: '#FAFAF7',      // text on dark surfaces (e.g. ink CTA)
  fgOnAccent: '#FAFAF7',   // text on green

  // Hairlines (do the work shadows would do — design system rule)
  hairline: '#E5E5E2',     // ink-100
  hairlineStrong: '#C8C8CC', // ink-200

  // Approval green (verified / done / safe — never a CTA bg)
  accent: '#1F8A4C',
  accentHover: '#166534',
  accentBg: '#DCFCE7',

  // Semantic
  success: '#1F8A4C',
  successBg: '#DCFCE7',
  warning: '#B45309',
  warningBg: '#FEF3C7',
  danger: '#B91C1C',
  dangerBg: '#FEE2E2',
  info: '#475569',
  infoBg: '#E2E8F0',

  // Per-app accent (in-app only — never CTA, never replaces approval green)
  appAccent,
  appAccentBg,

  // Ink primary-button pair — ink-on-paper. The canonical primary CTA color
  // (used by ReviewModal and any ink button). Distinct from fg/fgOnInk so a
  // button can't accidentally inherit body-text contrast rules.
  inkButton: '#0E0E0F',
  inkButtonText: '#FAFAF7',

  // Focus ring
  focusRing: '#1F8A4C',
};

// ---------- Dark palette ----------
const dark: typeof light = {
  bg: '#0B0B0C',
  bgElevated: '#131315',
  bgSubtle: '#1A1A1C',
  bgScrim: 'rgba(0, 0, 0, 0.6)',

  fg: '#F5F5F2',
  fgMuted: '#A0A0A6',
  fgSubtle: '#6B6B72',
  fgOnInk: '#F5F5F2',
  fgOnAccent: '#FFFFFF',

  hairline: '#26262A',
  hairlineStrong: '#3D3D42',

  accent: '#2EA866',          // green-500 lifts in dark
  accentHover: '#1F8A4C',
  accentBg: 'rgba(46, 168, 102, 0.15)',

  success: '#2EA866',
  successBg: 'rgba(46, 168, 102, 0.15)',
  warning: '#B45309',
  warningBg: 'rgba(180, 83, 9, 0.18)',
  danger: '#B91C1C',
  dangerBg: 'rgba(185, 28, 28, 0.18)',
  info: '#475569',
  infoBg: 'rgba(71, 85, 105, 0.22)',

  appAccent,
  appAccentBg: hexToRgba(APP_ACCENT, 0.15), // dark wash

  // Ink button inverts in dark: a paper button with dark label so it stays
  // the highest-contrast surface against the dark background.
  inkButton: '#F5F5F2',
  inkButtonText: '#0B0B0C',

  focusRing: '#2EA866',
};

export type Colors = typeof light;

export const lightColors: Colors = light;
export const darkColors: Colors = dark;

/**
 * Colors hook — returns the active palette based on system color scheme.
 *
 *   const { c } = useTheme();
 *   const s = makeStyles(c);
 */
export function useTheme(): { c: Colors; isDark: boolean } {
  const isDark = useColorScheme() === 'dark';
  return { c: isDark ? dark : light, isDark };
}
