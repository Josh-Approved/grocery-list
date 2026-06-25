/**
 * Bottom snackbar with an optional single action (Undo).
 *
 * No animation — it just appears and auto-dismisses. That keeps it
 * reduced-motion-correct by construction (canon § Accessibility) and the
 * Undo affordance always immediately tappable (the packing-list lesson:
 * an Undo you can't reach in time is not an Undo).
 *
 * Controlled: the screen owns `visible` + the payload; this renders chrome.
 */

import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  target,
  type as t,
  hairline,
  type Colors,
} from '../theme';

type Props = {
  visible: boolean;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  /** Auto-dismiss after this many ms (default 5000). */
  durationMs?: number;
  /** Extra bottom inset, e.g. the keyboard height, so the bar clears it. */
  bottomOffset?: number;
};

export function Snackbar({
  visible,
  message,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = 5000,
  bottomOffset = 0,
}: Props) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const s = makeStyles(c);

  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(id);
  }, [visible, durationMs, onDismiss]);

  if (!visible) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[s.wrap, { paddingBottom: insets.bottom + space.s5 + bottomOffset }]}
    >
      <View style={s.bar} accessibilityLiveRegion="polite">
        <Text style={s.message} numberOfLines={2}>
          {message}
        </Text>
        {actionLabel && onAction ? (
          <Pressable
            onPress={() => {
              onAction();
              onDismiss();
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            style={({ pressed }) => [s.action, pressed && s.pressed]}
          >
            <Text style={s.actionText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: space.s5,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.fg,
      borderRadius: radius.md,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      paddingLeft: space.s5,
      paddingRight: space.s3,
      minHeight: target.min,
    },
    message: {
      ...t.sm,
      flex: 1,
      fontFamily: fontFamily.sans,
      color: c.bg,
      paddingVertical: space.s4,
    },
    action: {
      minHeight: target.min,
      justifyContent: 'center',
      paddingHorizontal: space.s5,
    },
    actionText: {
      ...t.sm,
      fontFamily: fontFamily.sansSemibold,
      color: c.bg,
    },
    pressed: { opacity: 0.6 },
  });
}
