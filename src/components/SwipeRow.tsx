/**
 * Swipe-to-reveal-delete row.
 *
 * Wrap any row in this to add a left-swipe that slides the content aside and
 * reveals a Delete button. Tapping Delete fires `onDelete` (callers pair it
 * with an Undo snackbar — accidental delete is the universal grocery-app
 * complaint and the tenet here is "hard to lose").
 *
 * Why reveal-then-tap, not full-swipe-to-delete: a full swipe fires on the
 * release and is easy to trigger by accident while scrolling a list with a
 * thumb. Reveal-then-tap takes two deliberate gestures, which suits a
 * destructive action even with Undo behind it.
 *
 * Built on RN-core PanResponder + Animated — NO react-native-gesture-handler /
 * reanimated. Those native libs aren't installed (the ReorderAisles screen
 * deliberately avoids them) and adding them would force a rebuild. This is
 * pure JS, so it drops in with zero new native deps, iOS and Android alike.
 *
 * Accessibility: the Delete button is always mounted in the view hierarchy
 * (just visually occluded until the swipe), so VoiceOver / TalkBack reach it by
 * sequential navigation without needing the gesture. Swipe stays purely
 * additive — every caller keeps a non-swipe path to the same action too.
 */

import React, { useCallback, useRef } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { useReducedMotion } from './Dialogs';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  type as ty,
  type Colors,
} from '../theme';

type Props = {
  children: React.ReactNode;
  /** Fired when the revealed Delete button is tapped. */
  onDelete: () => void;
  /** Visible label on the action (e.g. "Delete"). */
  actionLabel: string;
  /** Full a11y label for the action (e.g. "Remove bananas"). */
  accessibilityLabel: string;
  /** Disable the swipe entirely (still renders children). */
  enabled?: boolean;
};

const ACTION_WIDTH = 96;
const OPEN_THRESHOLD = ACTION_WIDTH / 2;
// Horizontal travel before we claim the gesture — keeps vertical list scrolls
// and child taps working.
const H_ACTIVATE = 14;

export function SwipeRow({
  children,
  onDelete,
  actionLabel,
  accessibilityLabel,
  enabled = true,
}: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();

  const translateX = useRef(new Animated.Value(0)).current;
  const openRef = useRef(false);
  // Read mutable inputs through refs so the once-created PanResponder always
  // sees current values.
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const settle = useCallback(
    (to: number) => {
      openRef.current = to !== 0;
      if (reducedRef.current) {
        translateX.setValue(to);
        return;
      }
      Animated.spring(translateX, {
        toValue: to,
        useNativeDriver: true,
        bounciness: 0,
        speed: 18,
      }).start();
    },
    [translateX]
  );

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        enabledRef.current &&
        Math.abs(g.dx) > H_ACTIVATE &&
        Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => {
        const base = openRef.current ? -ACTION_WIDTH : 0;
        const next = base + g.dx;
        translateX.setValue(Math.max(-ACTION_WIDTH, Math.min(0, next)));
      },
      onPanResponderRelease: (_e, g) => {
        const base = openRef.current ? -ACTION_WIDTH : 0;
        const next = base + g.dx;
        settle(next < -OPEN_THRESHOLD ? -ACTION_WIDTH : 0);
      },
      onPanResponderTerminate: () => settle(openRef.current ? -ACTION_WIDTH : 0),
    })
  ).current;

  const handleDelete = useCallback(() => {
    settle(0);
    onDelete();
  }, [settle, onDelete]);

  if (!enabled) return <>{children}</>;

  return (
    <View style={s.wrap}>
      <View style={s.actionLayer} pointerEvents="box-none">
        <Pressable
          onPress={handleDelete}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          style={({ pressed }) => [s.action, pressed && s.actionPressed]}
        >
          <Trash2 size={18} color={c.fgOnAccent} strokeWidth={2} />
          <Text style={s.actionText} numberOfLines={1}>
            {actionLabel}
          </Text>
        </Pressable>
      </View>
      <Animated.View
        style={[s.content, { transform: [{ translateX }] }]}
        {...pan.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    wrap: { position: 'relative' },
    // The content rides on the row background so the action stays hidden until
    // the swipe slides it aside.
    content: { backgroundColor: c.bg },
    actionLayer: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    action: {
      width: ACTION_WIDTH,
      alignSelf: 'stretch',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.s2,
      backgroundColor: c.danger,
      borderRadius: radius.md,
      marginVertical: space.s1,
    },
    actionPressed: { opacity: 0.8 },
    actionText: {
      ...ty.sm,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgOnAccent,
    },
  });
}

export default SwipeRow;
