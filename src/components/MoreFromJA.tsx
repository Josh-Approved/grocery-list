/**
 * "More from Josh Approved" — the quiet in-app cross-promo row for the Settings
 * / About screen. Lists the studio's OTHER live apps, each opening its store
 * listing. Self-contained: depends only on the design-system theme barrel
 * (present in every app via `design-system-native`) and the synced `jaCatalog`,
 * so it drops cleanly into the shell AND into pre-shell hand-rolled screens.
 *
 * Canon (`canonical-voice.md` § Truth standard): the ONE allowed exception to
 * "No ads, ever" — plain text, not an ad unit. No images, no tap tracking, no
 * network. Renders NOTHING when no sibling app is live on the user's platform
 * (so it never shows a dead row, and stays invisible until the catalogue earns
 * a second live app). A trust surface, not an ad network.
 *
 * Usage: drop <MoreFromJA excludeSlug={selfSlug} /> at the foot of the About
 * section, above the attribution stamp. `selfSlug` is the host app's repo slug
 * (the canonical shell derives it from REPO_URL); omit it and the app simply
 * won't filter itself out (one redundant row, never a crash).
 *
 * Canonical, app-agnostic — synced by `sync.mjs more-from-ja` and carried by the
 * app shell. Do not fork.
 */

import React from 'react';
import { View, Text, Pressable, Linking, Platform, StyleSheet } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { moreFromJA } from './jaCatalog';
import { t } from '../i18n';
import {
  useTheme,
  fontFamily,
  space,
  target,
  type as ty,
  hairline,
  type Colors,
} from '../theme';

// The section label translates ("More from …" → "Más de …" / "Mehr von …"),
// but the studio name "Josh Approved" inside it never does (voice canon) — the
// per-locale string in shellLocales keeps the brand inline. Every app carries
// the i18n module, so reading this through t() is safe.

type Props = {
  /** Host app's repo slug, so it excludes itself. Optional. */
  excludeSlug?: string;
};

export function MoreFromJA({ excludeSlug }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const items = moreFromJA(Platform.OS, excludeSlug);
  if (!items.length) return null;

  return (
    <>
      <Text style={s.sectionLabel}>{t('about.moreFrom')}</Text>
      {items.map((app) => (
        <Pressable
          key={app.slug}
          style={({ pressed }) => [s.row, pressed && s.pressed]}
          onPress={() => Linking.openURL(app.url).catch(() => {})}
          accessibilityRole="button"
          accessibilityLabel={`${app.name} — ${app.blurb}`}
        >
          <View style={s.text}>
            <Text style={s.name}>{app.name}</Text>
            <Text style={s.blurb}>{app.blurb}</Text>
          </View>
          <ChevronRight size={18} color={c.fgSubtle} strokeWidth={1.5} />
        </Pressable>
      ))}
    </>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    sectionLabel: {
      ...ty.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      paddingHorizontal: space.s6,
      paddingTop: space.s7,
      paddingBottom: space.s3,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s4,
      minHeight: target.min + 6,
      paddingHorizontal: space.s6,
      paddingVertical: space.s3,
      borderBottomWidth: hairline,
      borderBottomColor: c.hairline,
    },
    text: { flex: 1, gap: 2 },
    name: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fg,
    },
    blurb: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
    },
    pressed: { opacity: 0.6 },
  });
}
