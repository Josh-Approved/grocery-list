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
  type as t,
  hairline,
  Colors,
} from '../theme';

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

const defaultBody = (appName: string) =>
  `${appName} is free and open-source. If it's earned a place in your day, your support keeps it going.`;

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
          <Text style={s.body}>{bodyText ?? defaultBody(appName)}</Text>
          <Pressable
            style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
            onPress={handleDonate}
            accessibilityRole="button"
            accessibilityLabel="Support this app, opens in your browser"
          >
            <Text style={s.primaryBtnText}>Support this app</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [s.secondaryBtn, pressed && s.pressed]}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Maybe later"
            hitSlop={8}
          >
            <Text style={s.secondaryBtnText}>Maybe later</Text>
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
      ...t.sm,
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
      ...t.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
    secondaryBtn: { paddingVertical: space.s2 },
    secondaryBtnText: {
      ...t.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
    },
    pressed: { opacity: 0.7 },
  });
}
