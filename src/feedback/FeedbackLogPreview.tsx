/**
 * The "what's shared" transparency modal for the Send-feedback flow — shows the
 * exact diagnostic text that will be attached, verbatim, so the user can read it
 * before sending. Extracted from FeedbackSheet to keep each file under the
 * component ceiling (engineering-standards.md). Presentation only; the parent
 * builds the report string and owns visibility.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 */

import React from 'react';
import { Modal, View, Text, Pressable, ScrollView } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { type Colors } from '../theme';
import { t } from '../i18n';
import { type FeedbackStyles } from './feedbackSheetStyles';

type Props = {
  visible: boolean;
  onClose: () => void;
  reduceMotion: boolean;
  report: string;
  c: Colors;
  s: FeedbackStyles;
};

export function FeedbackLogPreview({ visible, onClose, reduceMotion, report, c, s }: Props) {
  return (
    <Modal
      visible={visible}
      animationType={reduceMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
    >
      <SafeAreaProvider>
        <View style={s.backdrop}>
          <SafeAreaView style={s.sheet} edges={['top', 'bottom']}>
            <View style={s.header}>
              <View style={s.headerBtn} />
              <Text style={s.headerTitle} numberOfLines={1}>
                {t('feedback.logs.previewTitle')}
              </Text>
              <Pressable
                onPress={onClose}
                hitSlop={10}
                style={s.headerBtn}
                accessibilityRole="button"
                accessibilityLabel={t('common.done')}
              >
                <X size={22} color={c.fg} strokeWidth={1.5} />
              </Pressable>
            </View>
            <Text style={s.previewLead}>{t('feedback.logs.previewLead')}</Text>
            <ScrollView style={s.flex} contentContainerStyle={s.previewBody}>
              <Text style={s.previewText} selectable>
                {report}
              </Text>
            </ScrollView>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}
