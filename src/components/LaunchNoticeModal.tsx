// Canonical Josh Approved launch-notice modal.
// Source: josh-approved-factory/templates/launch-notice/LaunchNoticeModal.tsx
// Pairs with launchNotice.ts. See README.md for rules and wiring.
//
// Imports from '../theme' — every Josh Approved app has the design-system
// tokens synced into src/theme/. Don't reimplement styling here; the modal
// inherits from the design system so all apps look like siblings.
//
// Deliberately has ONE action. No store link, no feedback shortcut, no second
// button. See README § Why there is no review button.

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  AccessibilityInfo,
} from 'react-native';
import { markLaunchNoticeShown } from '../storage/launchNotice';
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
  /** Optional override for the AsyncStorage key (rare — multi-surface apps). */
  storageKey?: string;
}

export default function LaunchNoticeModal({
  visible,
  onDismiss,
  storageKey,
}: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);

  // Reduced-motion: collapse the fade to no animation when the OS
  // "reduce motion" setting is on (WCAG 2.2 AA — canonical non-negotiable).
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

  // Count the showing the moment it becomes visible, so the 3-session cap
  // holds even if the user back-dismisses or kills the app.
  useEffect(() => {
    if (visible) {
      markLaunchNoticeShown(storageKey);
    }
  }, [visible, storageKey]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      <View style={s.overlay}>
        <View
          style={s.card}
          accessibilityViewIsModal
          accessibilityLabel={t('launchNotice.title')}
        >
          <Text style={s.title}>{t('launchNotice.title')}</Text>
          <Text style={s.body}>{t('launchNotice.body')}</Text>
          <Pressable
            style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel={t('common.gotIt')}
          >
            <Text style={s.primaryBtnText}>{t('common.gotIt')}</Text>
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
      // Design-system --shadow-2 (modals/sheets elevation). RN shadows are
      // single-layer, so map to the dominant outer layer (ink #0E0E0F).
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
    },
    primaryBtnText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
    pressed: { opacity: 0.7 },
  });
}
