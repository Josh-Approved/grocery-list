// Canonical Josh Approved review modal.
// Source: josh-approved-factory/templates/review-prompt/ReviewModal.tsx
// Pairs with reviewPrompt.ts. See README.md for rules and wiring.
//
// Imports from '../theme' — every Josh Approved app has the design-system
// tokens synced into src/theme/. Don't reimplement styling here; the modal
// inherits from the design system so all apps look like siblings.

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Linking,
  Platform,
  AccessibilityInfo,
} from 'react-native';
import { markReviewOpened, markReviewPromptShown } from '../storage/reviewPrompt';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  type as ty,
  hairline,
  Colors,
} from '../theme';
import { t } from '../i18n';

interface Props {
  visible: boolean;
  onDismiss: () => void;
  /** App name as shown in the title — sentence case, no trademark. */
  appName: string;
  /** Numeric App Store ID (e.g. "6766071864"). */
  iosAppStoreId: string;
  /** Android applicationId (e.g. "com.jtysonwilliams.freeworkouttimer"). */
  androidPackageName: string;
  /** Optional override for the body line. Defaults to the canonical copy. */
  bodyText?: string;
  /** Optional override for the AsyncStorage key (rare — only for multi-surface apps). */
  storageKey?: string;
}

export default function ReviewModal({
  visible,
  onDismiss,
  appName,
  iosAppStoreId,
  androidPackageName,
  bodyText,
  storageKey,
}: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);

  // Reduced-motion: collapse the fade to no animation when the OS
  // "reduce motion" setting is on (WCAG 2.2 AA — canonical non-negotiable).
  // AccessibilityInfo.isReduceMotionEnabled() exists on both iOS and Android.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => setReduceMotion(enabled)
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  // Count this prompt as *shown* the moment it becomes visible — so the
  // maxPrompts ceiling holds even if the user back-dismisses or kills the app
  // without tapping "Not now".
  useEffect(() => {
    if (visible) {
      markReviewPromptShown(storageKey);
    }
  }, [visible, storageKey]);

  const handleReview = async () => {
    // Canonical write-review host is apps.apple.com (modern; itunes.apple.com
    // is legacy). ReviewModal is the authoritative source for this link.
    const id = Platform.OS === 'ios' ? iosAppStoreId : androidPackageName;
    const url =
      Platform.OS === 'ios'
        ? `itms-apps://apps.apple.com/app/id${iosAppStoreId}?action=write-review`
        : `https://play.google.com/store/apps/details?id=${androidPackageName}&showAllReviews=true`;

    // OPEN FIRST, mark second — and only mark on success.
    //
    // `markReviewOpened` stops every future prompt for this install, forever.
    // Marking before the link opened meant any failure (a blank store id on an
    // app that shipped before its listing existed, a device that can't handle
    // the scheme) silently opted the user out permanently: the modal closed,
    // nothing happened, and they were never asked again. `.catch(() => {})`
    // made it invisible. A missing id short-circuits for the same reason —
    // a broken URL must cost the user nothing.
    if (!id) {
      onDismiss();
      return;
    }
    const opened = await Linking.openURL(url).then(
      () => true,
      () => false
    );
    if (opened) await markReviewOpened(storageKey);
    onDismiss();
  };

  // "Not now" silently dismisses and stores nothing. The next eligible session
  // is positional — `REVIEW_CONFIG.promptAtSessions[promptsShown]` — and
  // `markReviewPromptShown` (on display, above) already advanced that pointer,
  // so there is no schedule to write here. A dismiss that wrote state would
  // double-count the one prompt the user just saw.
  const handleDismiss = () => {
    onDismiss();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      statusBarTranslucent
    >
      <View style={s.overlay}>
        <View style={s.card}>
          <Text style={s.title}>{t('review.title', { app: appName })}</Text>
          <Text style={s.body}>{bodyText ?? t('review.body')}</Text>
          <Pressable
            style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
            onPress={handleReview}
            accessibilityRole="button"
            accessibilityLabel={t('review.leaveA11y')}
          >
            <Text style={s.primaryBtnText}>{t('about.review')}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [s.secondaryBtn, pressed && s.pressed]}
            onPress={handleDismiss}
            accessibilityRole="button"
            accessibilityLabel={t('common.notNow')}
            hitSlop={8}
          >
            <Text style={s.secondaryBtnText}>{t('common.notNow')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: c.bgScrim,
      justifyContent: 'center',
      alignItems: 'center',
      padding: space.s7,
    },
    card: {
      width: '100%',
      backgroundColor: c.bgElevated,
      borderRadius: radius.lg,
      borderWidth: hairline,
      borderColor: c.hairline,
      padding: space.s7,
      alignItems: 'center',
      // Design-system --shadow-2 (modals/sheets elevation):
      // 0 4px 12px rgba(14,14,15,.10), 0 12px 32px rgba(14,14,15,.08).
      // RN shadows are single-layer, so map to the dominant outer layer
      // (color = ink #0E0E0F). elevation approximates --shadow-2 on Android.
      shadowColor: '#0E0E0F',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.08,
      shadowRadius: 32,
      elevation: 10,
    },
    title: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      textAlign: 'center',
      marginBottom: space.s3,
    },
    body: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
      marginBottom: space.s6,
    },
    primaryBtn: {
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
      paddingVertical: space.s4,
      paddingHorizontal: space.s7,
      width: '100%',
      alignItems: 'center',
      marginBottom: space.s3,
    },
    primaryBtnText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
    secondaryBtn: { paddingVertical: space.s2 },
    secondaryBtnText: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
    },
    pressed: { opacity: 0.7 },
  });
}
