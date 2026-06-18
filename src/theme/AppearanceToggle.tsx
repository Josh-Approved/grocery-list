/**
 * The canonical Light / Dark / System appearance control.
 *
 * Synced into each app at src/theme/AppearanceToggle.tsx by
 * `sync.mjs design-system-native`. Edit HERE, not per app — every app renders
 * the same control so the catalogue stays sibling-consistent (canon § Theming).
 *
 * It lives in the design system (not the app shell) because that's the one
 * module every app already syncs into src/theme/, and it is intrinsically a
 * theme surface. It is self-contained: colors from `useTheme()`, the preference
 * from `useThemePreference()`. Copy is passed in via `labels` (English
 * defaults) so it has no i18n dependency — apps with the i18n module pass
 * translated strings, apps without get sensible English.
 *
 *   // In the Settings screen, under an "Appearance" section label:
 *   <AppearanceToggle />
 *   // or, in an app with i18n:
 *   <AppearanceToggle labels={{
 *     title: t('settings.appearance'),
 *     system: t('settings.themeSystem'),
 *     light: t('settings.themeLight'),
 *     dark: t('settings.themeDark'),
 *   }} />
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme, type Colors } from './colors';
import { fontFamily, type as ty } from './typography';
import { space, radius, target } from './tokens';
import { useThemePreference, type ThemePref } from './themePreference';

export type AppearanceLabels = {
  /** Used only as the radiogroup's accessibility label (the visible section
   *  heading is owned by the screen, so it matches the app's other sections). */
  title: string;
  system: string;
  light: string;
  dark: string;
};

const DEFAULT_LABELS: AppearanceLabels = {
  title: 'Appearance',
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const OPTIONS: ThemePref[] = ['system', 'light', 'dark'];

export function AppearanceToggle({
  labels,
  style,
}: {
  labels?: Partial<AppearanceLabels>;
  /** Overrides/extends the row container. Default insets by the canonical
   *  screen gutter; pass `{ paddingHorizontal: 0 }` when the screen already
   *  pads its scroll container so the control aligns with the other rows. */
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const { pref, setPref } = useThemePreference();
  const L = { ...DEFAULT_LABELS, ...labels };
  const labelFor = (o: ThemePref) => (o === 'system' ? L.system : o === 'light' ? L.light : L.dark);

  return (
    <View style={[s.row, style]} accessibilityRole="radiogroup" accessibilityLabel={L.title}>
      {OPTIONS.map((o) => {
        const active = o === pref;
        return (
          <Pressable
            key={o}
            onPress={() => setPref(o)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={labelFor(o)}
            style={[s.btn, active && s.btnActive]}
          >
            <Text style={[s.text, active && s.textActive]}>{labelFor(o)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    row: { flexDirection: 'row', gap: space.s2, paddingHorizontal: space.s6 },
    btn: {
      flex: 1,
      minHeight: target.min,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: space.s3,
      borderRadius: radius.md,
      backgroundColor: c.bgSubtle,
    },
    btnActive: { backgroundColor: c.fg },
    text: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted },
    textActive: { ...ty.sm, fontFamily: fontFamily.sansSemibold, color: c.bg },
  });
}
