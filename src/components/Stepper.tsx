/**
 * Stepper — the +/- quantity control.
 *
 * Design system constraints:
 *   - No bouncy press animation. Opacity/background dim on press only.
 *   - Approval green is reserved for verified/done — never used here.
 *   - Mono tabular digits so the column doesn't shift width as you tap.
 *
 * Behavior:
 *   - Tap +/- to step by 1, with a selection haptic.
 *   - Clamps at min/max.
 *   - If `onRemove` is provided, − while at min (or long-pressing −) removes.
 */

import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Minus, Plus } from 'lucide-react-native';
import { t } from '../i18n';
import { useTheme, typography, radius, target, type Colors } from '../theme';

type Props = {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** If provided, − while at min (or long-pressing −) calls this. */
  onRemove?: () => void;
  label?: string;
};

export function Stepper({
  value,
  onChange,
  min = 1,
  max = Number.POSITIVE_INFINITY,
  onRemove,
  label,
}: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);

  const tap = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const handleMinus = useCallback(() => {
    tap();
    if (value <= min) {
      if (onRemove) onRemove();
      return;
    }
    onChange(value - 1);
  }, [value, min, onRemove, onChange, tap]);

  const handlePlus = useCallback(() => {
    tap();
    if (value >= max) return;
    onChange(value + 1);
  }, [value, max, onChange, tap]);

  const handleLongPressMinus = useCallback(() => {
    if (onRemove) {
      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Warning
      ).catch(() => {});
      onRemove();
    }
  }, [onRemove]);

  const minusDisabled = value <= min && !onRemove;
  const plusDisabled = value >= max;

  return (
    <View
      style={s.container}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: String(value) }}
    >
      <Pressable
        onPress={handleMinus}
        onLongPress={handleLongPressMinus}
        disabled={minusDisabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={
          onRemove && value <= min ? t('stepper.remove') : t('stepper.decrease')
        }
        style={({ pressed }) => [
          s.btn,
          s.btnLeft,
          minusDisabled && s.btnDisabled,
          pressed && !minusDisabled && s.btnPressed,
        ]}
      >
        <Minus
          size={18}
          color={minusDisabled ? c.fgSubtle : c.fg}
          strokeWidth={1.5}
        />
      </Pressable>

      <View style={s.numberWrap}>
        <Text
          style={s.number}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {value}
        </Text>
      </View>

      <Pressable
        onPress={handlePlus}
        disabled={plusDisabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={t('stepper.increase')}
        style={({ pressed }) => [
          s.btn,
          s.btnRight,
          plusDisabled && s.btnDisabled,
          pressed && !plusDisabled && s.btnPressed,
        ]}
      >
        <Plus
          size={18}
          color={plusDisabled ? c.fgSubtle : c.fg}
          strokeWidth={1.5}
        />
      </Pressable>
    </View>
  );
}

function makeStyles(c: Colors) {
  const btnSize = target.min; // 44pt min (design system floor)
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.hairline,
      backgroundColor: c.bgElevated,
      overflow: 'hidden',
      alignSelf: 'flex-start',
    },
    btn: {
      width: btnSize,
      height: btnSize,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.bgElevated,
    },
    btnLeft: { borderRightWidth: 1, borderRightColor: c.hairline },
    btnRight: { borderLeftWidth: 1, borderLeftColor: c.hairline },
    btnPressed: { backgroundColor: c.bgSubtle, opacity: 0.85 },
    btnDisabled: { backgroundColor: c.bgSubtle },
    numberWrap: {
      width: 44,
      height: btnSize,
      alignItems: 'center',
      justifyContent: 'center',
    },
    number: {
      fontFamily: typography.monoEmphasis,
      fontSize: 18,
      lineHeight: 22,
      color: c.fg,
      fontVariant: ['tabular-nums'],
    },
  });
}
