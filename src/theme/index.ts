// Canonical Josh Approved theme — native public surface.
// Synced verbatim into each app at src/theme/index.ts by
// `sync.mjs design-system-native`. Edit the canonical files here, not per app.

export {
  typography,
  fontFamilies,
  fontFamily,
  type,
  tracking,
} from './typography';
export type { TypographyRole, FontFamily, TypeStep, Tracking } from './typography';

export { useAppFonts } from './useAppFonts';

export {
  appAccent,
  appAccentBg,
  lightColors,
  darkColors,
  useTheme,
} from './colors';
export type { Colors } from './colors';

export { space, radius, target, motion, hairline } from './tokens';
