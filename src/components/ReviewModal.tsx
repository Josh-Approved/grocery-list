// Canonical Josh Approved review surface.
// Source: josh-approved-factory/templates/review-prompt/ReviewModal.tsx
// Pairs with reviewPrompt.ts. See README.md for rules and wiring.
//
// Since 2026-10-17 the surface is the OS-native in-app rating sheet —
// SKStoreReviewController on iOS, the Google Play In-App Review flow on Android,
// both via expo-store-review. The user rates in place, in one tap, without
// leaving the app; that is what the store leaders in every category do and it is
// why their rating counts dwarf ours. The custom modal below survives only as
// the FALLBACK, shown when the native sheet is unavailable on this device
// (`isAvailableAsync()` false — no Play Store, an unsupported OS — or the
// request itself fails). The file keeps its name so every mount site, the sync
// manifest and the `review-prompt/wired` QA rule stay valid.
//
// Imports from '../theme' — every Josh Approved app has the design-system
// tokens synced into src/theme/. Don't reimplement styling here; the fallback
// inherits from the design system so all apps look like siblings.

import React, { useEffect, useRef, useState } from 'react';
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
import * as StoreReview from 'expo-store-review';
import { markReviewOpened, markReviewPromptShown } from '../storage/reviewPrompt';
import { logEvent } from '../feedback/log';
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

/**
 * Ask the OS for its rating sheet. Resolves true when the request was made —
 * NOT when a sheet was seen: both platforms decide for themselves whether to
 * show anything (Apple caps at 3 per 365 days and suppresses in TestFlight;
 * Google applies an undocumented quota and shows nothing for a build that did
 * not come from Play) and neither reports back. False means the native path is
 * unavailable here and the caller should fall back to the custom modal.
 */
async function requestNativeReview(): Promise<boolean> {
  try {
    if (!(await StoreReview.isAvailableAsync())) return false;
    await StoreReview.requestReview();
    return true;
  } catch {
    return false;
  }
}

interface Props {
  /**
   * The shell flips this true when the prompt is due. The component then
   * presents — native sheet first — and calls `onDismiss` itself when the
   * native request has been made, so the shell needs no knowledge of which
   * surface was used.
   */
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

  // Which surface this presentation is using. 'pending' while the native
  // request is in flight (nothing rendered); 'fallback' renders the modal.
  const [surface, setSurface] = useState<'pending' | 'fallback'>('pending');
  // Latest onDismiss without re-running the effect: the shell passes an inline
  // arrow, so its identity changes every render.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!visible) {
      setSurface('pending');
      return;
    }
    let cancelled = false;
    (async () => {
      // Count this prompt as *shown* FIRST — before the native request, before
      // the fallback renders — so the 3-per-install ceiling holds whatever
      // happens next: a sheet the OS chose not to show, a back-dismiss, an app
      // kill. None of those paths reach a dismiss handler.
      await markReviewPromptShown(storageKey);
      const native = await requestNativeReview();
      if (cancelled) return;
      if (native) {
        // The OS owns the sheet from here. Nothing of ours to render, nothing
        // to mark: we cannot know whether the user rated.
        logEvent('review', 'native sheet requested');
        onDismissRef.current();
        return;
      }
      logEvent('review', 'fallback modal shown');
      setSurface('fallback');
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, storageKey]);

  const handleReview = async () => {
    // Canonical write-review host is apps.apple.com (modern; itunes.apple.com
    // is legacy). ReviewModal is the authoritative source for this link.
    //
    // Android lands on the plain listing, and that is correct, not a gap.
    // Google documents no deep link that opens a review composer — the only
    // sanctioned in-app path is the Play In-App Review API, and its own docs
    // say NOT to put a button behind it: "you should not have a call-to-action
    // option (such as a button) to trigger the API, as a user might have
    // already hit their quota and the flow won't be shown, presenting a broken
    // experience to the user. For this use case, redirect the user to the Play
    // Store instead." (developer.android.com/guide/playcore/in-app-review,
    // re-read 2026-08-14). This modal is exactly that call-to-action, so the
    // listing link-out is the prescribed behaviour. The old
    // `&showAllReviews=true` parameter was dropped here: it no longer opens
    // anything and only made the URL look like it did something it didn't.
    const id = Platform.OS === 'ios' ? iosAppStoreId : androidPackageName;
    const url =
      Platform.OS === 'ios'
        ? `itms-apps://apps.apple.com/app/id${iosAppStoreId}?action=write-review`
        : `https://play.google.com/store/apps/details?id=${androidPackageName}`;

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
      visible={visible && surface === 'fallback'}
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
            // Label must equal the visible text or Voice Control can't activate
            // it by name; the store detail moves to the hint. (ja: visible
            // "レビューを書く" was the TAIL of "アプリストアでレビューを書く".)
            accessibilityLabel={t('about.review')}
            accessibilityHint={t('review.leaveA11y')}
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
