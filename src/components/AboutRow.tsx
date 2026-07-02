/**
 * A single Settings/About row: optional leading Lucide icon, label, and either
 * a trailing value (e.g. the version) or an external-link chevron. Hairline-
 * separated, no button chrome — design-system restraint. One component for
 * every canonical entry — no per-row restyling.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork. (This
 * is the de-drifted single source: grocery-list / packing-list had forked
 * variants before the app-shell module.)
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import {
  useTheme,
  fontFamily,
  space,
  target,
  type as t,
  hairline,
  type Colors,
} from '../theme';

type Props = {
  label: string;
  icon?: LucideIcon;
  /** Static trailing text (e.g. "1.0.0 (1)"). Mutually exclusive with onPress. */
  value?: string;
  onPress?: () => void;
};

export function AboutRow({ label, icon: Icon, value, onPress }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const body = (
    <>
      {Icon ? <Icon size={20} color={c.fgMuted} strokeWidth={1.5} /> : null}
      <Text style={s.label}>{label}</Text>
      {value ? (
        <Text style={s.value}>{value}</Text>
      ) : onPress ? (
        <ChevronRight size={18} color={c.fgSubtle} strokeWidth={1.5} />
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View style={s.row} accessibilityLabel={`${label}${value ? `, ${value}` : ''}`}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      style={({ pressed }) => [s.row, pressed && s.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {body}
    </Pressable>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s4,
      minHeight: target.min + 6,
      paddingHorizontal: space.s6,
      borderBottomWidth: hairline,
      borderBottomColor: c.hairline,
    },
    label: {
      ...t.base,
      flex: 1,
      fontFamily: fontFamily.sans,
      color: c.fg,
    },
    value: {
      ...t.sm,
      fontFamily: fontFamily.mono,
      color: c.fgMuted,
    },
    pressed: { opacity: 0.6 },
  });
}
