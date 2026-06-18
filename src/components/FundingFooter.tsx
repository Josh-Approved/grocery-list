/**
 * The tertiary funding + feedback text-link row for a primary screen (canon
 * § Funding & feedback — dual placement: quiet here, obvious in Settings).
 * Small muted Lucide icon, sentence-case label, no chrome. Present, not
 * promotional — the label is the entire pitch.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { HandHeart, Mail } from 'lucide-react-native';
import { BMAC_URL, openUrl, openFeedbackMail } from '../lib/links';
import { t } from '../i18n';
import {
  useTheme,
  fontFamily,
  space,
  target,
  type as ty,
  type Colors,
} from '../theme';

export function FundingFooter() {
  const { c } = useTheme();
  const s = makeStyles(c);
  return (
    <View style={s.wrap}>
      <Pressable
        style={({ pressed }) => [s.link, pressed && s.pressed]}
        onPress={() => openUrl(BMAC_URL)}
        accessibilityRole="button"
        accessibilityLabel={t('about.support')}
      >
        <HandHeart size={14} color={c.fgMuted} strokeWidth={1.5} />
        <Text style={s.text}>{t('about.support')}</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [s.link, pressed && s.pressed]}
        onPress={openFeedbackMail}
        accessibilityRole="button"
        accessibilityLabel={t('about.feedback')}
      >
        <Mail size={14} color={c.fgMuted} strokeWidth={1.5} />
        <Text style={s.text}>{t('about.feedback')}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: space.s7,
      paddingVertical: space.s5,
    },
    link: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
      minHeight: target.min,
    },
    text: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
    },
    pressed: { opacity: 0.6 },
  });
}
