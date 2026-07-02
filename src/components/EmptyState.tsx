/**
 * The canonical empty state — a single muted sentence, centered, no
 * illustration (design-system restraint; canon voice). Used by every list /
 * tracker home screen ("No lists yet. Tap + to add one."). Canonical,
 * app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme, fontFamily, space, type as ty, type Colors } from '../theme';

export function EmptyState({ message }: { message: string }) {
  const { c } = useTheme();
  const s = makeStyles(c);
  return (
    <View style={s.wrap}>
      <Text style={s.text}>{message}</Text>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    wrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.s7,
    },
    text: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
    },
  });
}
