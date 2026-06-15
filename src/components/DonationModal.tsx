// Canonical Josh Approved donation modal.
// Source: josh-approved-factory/templates/donation-prompt/DonationModal.tsx
// Pairs with donationPrompt.ts. See README.md for rules and wiring.
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
  AccessibilityInfo,
} from 'react-native';
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

const BMAC_URL = 'https://buymeacoffee.com/jtysonwilliams';

interface Props {
  visible: boolean;
  onDismiss: () => void;
  /** App name as shown in the body line — sentence case, no trademark. */
  appName: string;
  /** Optional override for the body line. Defaults to the canonical copy. */
  bodyText?: string;
  /** Optional override for the AsyncStorage key (rare — only for multi-surface apps). */
  storageKey?: string;
}

export default function DonationModal({
  visible,
  onDismiss,
  appName,
  bodyText,
}: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion
    );
    return () => sub.remove();
  }, []);

  const handleDonate = async () => {
    await Linking.openURL(BMAC_URL).catch(() => {});
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
          <Text style={s.body}>{bodyText ?? t('donate.body', { app: appName })}</Text>
          <Pressable
            style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
            onPress={handleDonate}
            accessibilityRole="button"
            accessibilityLabel={t('donate.supportA11y')}
          >
            <Text style={s.primaryBtnText}>{t('about.support')}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [s.secondaryBtn, pressed && s.pressed]}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel={t('common.maybeLater')}
            hitSlop={8}
          >
            <Text style={s.secondaryBtnText}>{t('common.maybeLater')}</Text>
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
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.18,
      shadowRadius: 16,
      elevation: 10,
    },
    body: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fg,
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
