/**
 * A back-button + title row for a non-root screen (Settings, a detail screen).
 * Bounded to the content column, 44pt targets, sentence-case title. Optional
 * trailing action slot. Canonical, app-agnostic — synced by `sync.mjs
 * app-shell`; do not fork.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { t } from '../i18n';
import {
  useTheme,
  fontFamily,
  space,
  target,
  type as ty,
  boundedContent,
  type Colors,
} from '../theme';

type Props = {
  title: string;
  onBack: () => void;
  /** Optional trailing element (an action button). Reserves a 44pt slot when
   *  absent so the title stays centered. */
  right?: React.ReactNode;
};

export function ScreenHeader({ title, onBack, right }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  return (
    <View style={s.header}>
      <Pressable
        onPress={onBack}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
      >
        <ChevronLeft size={24} color={c.fg} strokeWidth={1.5} />
      </Pressable>
      <Text style={s.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={s.iconBtn}>{right}</View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    header: {
      ...boundedContent,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.s4,
      paddingVertical: space.s3,
    },
    title: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },
    iconBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: { opacity: 0.6 },
  });
}
