/**
 * Step 1 of the Send-feedback flow — pick a kind (Report a bug / Request a
 * feature / General). Extracted from FeedbackSheet to keep each file under the
 * component ceiling (engineering-standards.md). Presentation only; the parent
 * owns all state and passes down the shared theme + styles.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 */

import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Bug, Sparkles, MessageSquare, ChevronRight } from 'lucide-react-native';
import { type Colors } from '../theme';
import { t } from '../i18n';
import { type FeedbackType } from './compose';
import { type FeedbackStyles } from './feedbackSheetStyles';

const TYPES: { type: FeedbackType; icon: typeof Bug; titleKey: string; descKey: string }[] = [
  { type: 'bug', icon: Bug, titleKey: 'feedback.type.bug', descKey: 'feedback.type.bugDesc' },
  { type: 'feature', icon: Sparkles, titleKey: 'feedback.type.feature', descKey: 'feedback.type.featureDesc' },
  { type: 'general', icon: MessageSquare, titleKey: 'feedback.type.general', descKey: 'feedback.type.generalDesc' },
];

type Props = {
  onChoose: (next: FeedbackType) => void;
  c: Colors;
  s: FeedbackStyles;
};

export function FeedbackTypePicker({ onChoose, c, s }: Props) {
  return (
    <ScrollView contentContainerStyle={s.pickerBody}>
      <Text style={s.pickerLead}>{t('feedback.lead')}</Text>
      {TYPES.map(({ type: tp, icon: Icon, titleKey, descKey }) => (
        <Pressable
          key={tp}
          onPress={() => onChoose(tp)}
          style={({ pressed }) => [s.typeCard, pressed && s.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${t(titleKey)}. ${t(descKey)}`}
        >
          <View style={s.typeIcon}>
            <Icon size={20} color={c.appAccent} strokeWidth={1.5} />
          </View>
          <View style={s.typeText}>
            <Text style={s.typeTitle}>{t(titleKey)}</Text>
            <Text style={s.typeDesc}>{t(descKey)}</Text>
          </View>
          <ChevronRight size={18} color={c.fgSubtle} strokeWidth={1.5} />
        </Pressable>
      ))}
    </ScrollView>
  );
}
