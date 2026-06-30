/**
 * The main-screen funding + feedback footer (canon § Funding & feedback).
 *
 * Two equal-width secondary / ghost buttons side by side — Support (the in-app
 * tip jar, or the BMAC fallback) on the left, Send feedback on the right — with
 * the "josh approved" wordmark lockup signing off beneath. Ghost buttons
 * (hairline border, no fill) read clearly below the screen's ink primary CTA
 * without competing with it; feedback is the studio's lifeline, so it sits in
 * the natural primary-action (right) slot. The lockup puts the brand at the foot
 * of every main screen, so a user who never opens Settings still meets the mark
 * (canon § Brand assets).
 *
 * Labels are deliberately short ("Support" / "Send feedback") so two buttons fit
 * side by side down to iPhone-SE width; the visible text shrinks to one line
 * under large Dynamic Type while the screen-reader label stays the full
 * "Support this app" / "Send feedback".
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  interpolate,
  type SharedValue,
} from 'react-native-reanimated';
import { HandHeart, Mail } from 'lucide-react-native';
import { BMAC_URL, openUrl } from '../lib/links';
import { useFeedback } from '../feedback/FeedbackProvider';
import { Wordmark } from './Wordmark';
import { t } from '../i18n';
import {
  useTheme,
  fontFamily,
  space,
  target,
  radius,
  hairline,
  type as ty,
  type Colors,
} from '../theme';

type Props = {
  /** When set, the support button opens the in-app tip jar instead of the BMAC
   *  link-out (canon § Tip jar — the 3.1.1-compliant IAP replacement). */
  onSupport?: () => void;
  /** 0→1 progress of the bottom-overscroll pull (from usePullRevealFooter). At
   *  0 the wordmark is hidden; at 1 it has fully popped in. */
  reveal?: SharedValue<number>;
  /** When true the wordmark is hidden at rest and pops in on pull (the splash
   *  pop, echoed at the foot of the screen). When false it is statically shown
   *  — the fallback where the platform has no bottom-overscroll bounce. */
  pullToReveal?: boolean;
};

export function FundingFooter({ onSupport, reveal, pullToReveal }: Props = {}) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const { open: openFeedback } = useFeedback();

  // The exact splash pop, re-keyed to the pull instead of a timeline: opacity +
  // a small rise (14→0) + a scale-settle (0.85→1), the single ease-out curve.
  const revealStyle = useAnimatedStyle(() => {
    const p = reveal ? reveal.value : 0;
    return {
      opacity: p,
      transform: [
        { translateY: interpolate(p, [0, 1], [14, 0]) },
        { scale: interpolate(p, [0, 1], [0.85, 1]) },
      ],
    };
  });

  return (
    <View style={s.wrap}>
      <View style={s.row}>
        <Pressable
          style={({ pressed }) => [s.btn, pressed && s.pressed]}
          onPress={onSupport ?? (() => openUrl(BMAC_URL))}
          accessibilityRole="button"
          accessibilityLabel={t('about.support')}
        >
          <HandHeart size={16} color={c.fg} strokeWidth={1.5} />
          <Text style={s.btnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
            {t('about.supportShort')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [s.btn, pressed && s.pressed]}
          onPress={() => openFeedback()}
          accessibilityRole="button"
          accessibilityLabel={t('about.feedback')}
        >
          <Mail size={16} color={c.fg} strokeWidth={1.5} />
          <Text style={s.btnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
            {t('about.feedback')}
          </Text>
        </Pressable>
      </View>
      {pullToReveal ? (
        <Animated.View style={[s.lockup, revealStyle]}>
          <Wordmark />
        </Animated.View>
      ) : (
        <View style={s.lockup}>
          <Wordmark />
        </View>
      )}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    wrap: {
      alignItems: 'center',
      gap: space.s4,
      paddingTop: space.s5,
      paddingBottom: space.s6,
      paddingHorizontal: space.s5,
    },
    // Two equal-width ghost buttons.
    row: {
      flexDirection: 'row',
      alignSelf: 'stretch',
      gap: space.s4,
    },
    // Ghost / secondary CTA — hairline border, no fill, ink label.
    btn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.s2,
      minHeight: target.min,
      paddingVertical: space.s2,
      paddingHorizontal: space.s4,
      borderRadius: radius.md,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
    },
    btnText: {
      ...ty.sm,
      fontFamily: fontFamily.sansMedium,
      color: c.fg,
    },
    // Tight, deliberate ~14pt below the buttons (wrap gap space.s4 + this) — the
    // wordmark springs into this gap on pull rather than sitting far beneath.
    lockup: {
      paddingTop: space.s1,
    },
    pressed: { opacity: 0.6 },
  });
}
