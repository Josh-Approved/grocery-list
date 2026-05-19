// Canonical Josh Approved review modal.
// Source: josh-approved-factory/templates/review-prompt/ReviewModal.tsx
// Pairs with reviewPrompt.ts. See README.md for rules and wiring.
//
// Imports from '../theme' — every Josh Approved app has the design-system
// tokens synced into src/theme/. Don't reimplement styling here; the modal
// inherits from the design system so all apps look like siblings.

import React from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Linking,
  Platform,
} from 'react-native';
import { markReviewOpened, dismissReviewPrompt } from '../storage/reviewPrompt';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  type as t,
  hairline,
  Colors,
} from '../theme';

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

const DEFAULT_BODY =
  'A quick rating helps more people find this free, ad-free app.';

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

  const handleReview = async () => {
    await markReviewOpened(storageKey);
    const url =
      Platform.OS === 'ios'
        ? `itms-apps://itunes.apple.com/app/id${iosAppStoreId}?action=write-review`
        : `https://play.google.com/store/apps/details?id=${androidPackageName}&showAllReviews=true`;
    await Linking.openURL(url).catch(() => {});
    onDismiss();
  };

  const handleDismiss = async () => {
    await dismissReviewPrompt(storageKey);
    onDismiss();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={s.overlay}>
        <View style={s.card}>
          <Text style={s.title}>{`Enjoying ${appName}?`}</Text>
          <Text style={s.body}>{bodyText ?? DEFAULT_BODY}</Text>
          <Pressable
            style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
            onPress={handleReview}
            accessibilityRole="button"
            accessibilityLabel="Leave a review on the app store"
          >
            <Text style={s.primaryBtnText}>Leave a review</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [s.secondaryBtn, pressed && s.pressed]}
            onPress={handleDismiss}
            accessibilityRole="button"
            accessibilityLabel="Not now"
            hitSlop={8}
          >
            <Text style={s.secondaryBtnText}>Not now</Text>
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
    title: {
      ...t.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      textAlign: 'center',
      marginBottom: space.s3,
    },
    body: {
      ...t.sm,
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
