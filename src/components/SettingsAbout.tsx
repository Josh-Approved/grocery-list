/**
 * The canonical About block for the Settings screen — every required entry
 * (canon § Settings / About) in the locked order, plus the "josh approved"
 * attribution stamp. One component, used unmodified in every app; the app's
 * SettingsScreen drops its own settings ABOVE this and renders <SettingsAbout/>
 * at the bottom.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork. (Before
 * the app-shell module each app hand-rolled this block and they drifted.)
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { HandHeart, Mail, Star, Shield, Code2, Library } from 'lucide-react-native';
import { AboutRow } from './AboutRow';
import { Wordmark } from './Wordmark';
import { MoreFromJA } from './MoreFromJA';
import { useFeedback } from '../feedback/FeedbackProvider';
import { t } from '../i18n';
import {
  BMAC_URL,
  PRIVACY_URL,
  REPO_URL,
  STUDIO_URL,
  openReview,
  openUrl,
  versionLabel,
} from '../lib/links';
import {
  useTheme,
  fontFamily,
  space,
  type as ty,
  type Colors,
} from '../theme';

type Props = {
  /** Navigate to the Acknowledgements screen. */
  onAcknowledgements: () => void;
  /** When set, the support row opens the in-app tip jar instead of the BMAC
   *  link-out (canon § Tip jar — the 3.1.1-compliant IAP replacement). */
  onSupport?: () => void;
};

export function SettingsAbout({ onAcknowledgements, onSupport }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const { open: openFeedback } = useFeedback();
  // Repo slug (last path segment of REPO_URL) — used so the cross-promo row
  // excludes the host app from its own "More from Josh Approved" list.
  const selfSlug = (REPO_URL.split('/').pop() || '').toLowerCase();
  return (
    <>
      <Text style={s.sectionLabel}>{t('settings.about')}</Text>
      <AboutRow label={t('about.support')} icon={HandHeart} onPress={onSupport ?? (() => openUrl(BMAC_URL))} />
      <AboutRow label={t('about.feedback')} icon={Mail} onPress={() => openFeedback()} />
      <AboutRow label={t('about.review')} icon={Star} onPress={openReview} />
      <AboutRow label={t('about.privacy')} icon={Shield} onPress={() => openUrl(PRIVACY_URL)} />
      <AboutRow label={t('about.source')} icon={Code2} onPress={() => openUrl(REPO_URL)} />
      <AboutRow label={t('about.acknowledgements')} icon={Library} onPress={onAcknowledgements} />
      <AboutRow label={t('about.version')} value={versionLabel()} />

      <MoreFromJA excludeSlug={selfSlug} />

      <View style={s.stamp}>
        <Wordmark />
        <Text style={s.stampLine}>{t('about.oneLiner')}</Text>
        <Pressable
          onPress={() => openUrl(STUDIO_URL)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('about.learnMoreA11y')}
        >
          <Text style={s.learnMore}>{t('about.learnMore')}</Text>
        </Pressable>
      </View>
    </>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    sectionLabel: {
      ...ty.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      paddingHorizontal: space.s6,
      paddingTop: space.s7,
      paddingBottom: space.s3,
    },
    stamp: {
      alignItems: 'center',
      paddingHorizontal: space.s7,
      paddingTop: space.s9,
      gap: space.s3,
    },
    stampLine: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
    },
    learnMore: {
      ...ty.sm,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      paddingVertical: space.s2,
    },
  });
}
