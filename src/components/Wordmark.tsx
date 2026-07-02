/**
 * The canonical "josh approved" wordmark — Lucide Check in approval green
 * (strokeWidth 3) + lowercase "josh approved" in IBM Plex Sans SemiBold.
 *
 * Brand-asset integrity (canon § Brand assets): never recolored, redrawn, or
 * restyled per app. The same mark sits at the foot of every Settings screen
 * and on the cold-start splash. Approval green is the only place green is used
 * here. Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Check } from 'lucide-react-native';
import { useTheme, fontFamily, space, tracking, type Colors } from '../theme';

export function Wordmark() {
  const { c } = useTheme();
  const s = makeStyles(c);
  return (
    <View style={s.row} accessibilityRole="image" accessibilityLabel="josh approved">
      <Check size={18} color={c.accent} strokeWidth={3} />
      <Text style={s.text} importantForAccessibility="no">
        josh approved
      </Text>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
    },
    text: {
      fontFamily: fontFamily.sansSemibold,
      fontSize: 16,
      lineHeight: 20,
      letterSpacing: tracking.mark,
      color: c.fg,
    },
  });
}
