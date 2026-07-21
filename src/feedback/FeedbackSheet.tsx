/**
 * The Send-feedback flow — pick a kind (Report a bug / Request a feature /
 * General), fill a short guided form, and hand off to the user's email with the
 * environment auto-filled and (for bugs, opt-out) the diagnostic log attached.
 *
 * One canonical sheet, used unmodified across the catalogue (like TipJarSheet /
 * ReviewModal — the custom UI we allow because it is ONE custom UI, not many).
 * Inherits the design system from '../theme'; don't restyle per app.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * This file orchestrates the flow (state + header + the guided form); the two
 * self-contained sub-views (FeedbackTypePicker = step 1, FeedbackLogPreview =
 * the transparency modal) and the shared styles live in sibling files so each
 * stays under the component ceiling (engineering-standards.md).
 *
 * Copy lives in shellStrings.ts (translated in shellLocales.ts) — voice canon
 * applies: calm, plain second person, no urgency. The "good bug report" coaching
 * follows the standard checklist (what happened / expected / steps / how often),
 * and the feature prompts draw out the WHY, because most reports under-explain it.
 */

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  AccessibilityInfo,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  X,
  CheckSquare,
  Square,
  FileText,
} from 'lucide-react-native';
import { useTheme, space } from '../theme';
import { t } from '../i18n';
import { collectDiagnostics } from './diagnostics';
import { buildLogReport, sendFeedback, FIELDS, type FeedbackType } from './compose';
import { makeStyles } from './feedbackSheetStyles';
import { FeedbackTypePicker } from './FeedbackTypePicker';
import { FeedbackLogPreview } from './FeedbackLogPreview';

type Props = {
  visible: boolean;
  initialType?: FeedbackType;
  onClose: () => void;
};

export function FeedbackSheet({ visible, initialType, onClose }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);

  const [type, setType] = useState<FeedbackType | null>(initialType ?? null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [includeLogs, setIncludeLogs] = useState(true);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  // Reset to a clean state each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setType(initialType ?? null);
      setIncludeLogs((initialType ?? 'general') === 'bug');
      setFields({});
      setSending(false);
      setFailed(false);
      setPreviewOpen(false);
    }
  }, [visible, initialType]);

  function chooseType(next: FeedbackType) {
    setType(next);
    setIncludeLogs(next === 'bug');
    setFields({});
    setFailed(false);
  }

  async function onSend() {
    if (!type) return;
    setSending(true);
    setFailed(false);
    const result = await sendFeedback({ type, fields, includeLogs });
    setSending(false);
    if (result.status === 'failed') setFailed(true);
    else onClose();
  }

  const diag = collectDiagnostics();
  const envSummary = `${diag.app} ${diag.version} · ${diag.device} · ${diag.platform} ${diag.osVersion}`;

  return (
    <Modal
      visible={visible}
      animationType={reduceMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
      presentationStyle="overFullScreen"
      transparent
    >
      <SafeAreaProvider>
        <View style={s.backdrop}>
          <SafeAreaView style={s.sheet} edges={['top', 'bottom']}>
            {/* Header */}
            <View style={s.header}>
              {type ? (
                <Pressable
                  onPress={() => setType(null)}
                  hitSlop={10}
                  style={s.headerBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.back')}
                >
                  <ChevronLeft size={22} color={c.fg} strokeWidth={1.5} />
                </Pressable>
              ) : (
                <View style={s.headerBtn} />
              )}
              <Text style={s.headerTitle} numberOfLines={2}>
                {type ? t(`feedback.${type}.title`) : t('feedback.title')}
              </Text>
              <Pressable
                onPress={onClose}
                hitSlop={10}
                style={s.headerBtn}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
              >
                <X size={22} color={c.fg} strokeWidth={1.5} />
              </Pressable>
            </View>

            {!type ? (
              // ---- Step 1: pick a kind ----
              <FeedbackTypePicker onChoose={chooseType} c={c} s={s} />
            ) : (
              // ---- Step 2: the guided form ----
              <KeyboardAvoidingView
                style={s.flex}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              >
                <ScrollView
                  contentContainerStyle={s.formBody}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="interactive"
                >
                  {type === 'bug' && (
                    <View style={s.tipCard}>
                      <Text style={s.tipTitle}>{t('feedback.bug.guidanceTitle')}</Text>
                      <Text style={s.tipBody}>{t('feedback.bug.guidance')}</Text>
                    </View>
                  )}

                  {FIELDS[type].map((f) => {
                    const multiline = f.lines > 1;
                    return (
                      <View key={f.key} style={s.field}>
                        <Text style={s.label}>{t(f.labelKey)}</Text>
                        <TextInput
                          style={[s.input, multiline && { minHeight: 22 * f.lines + space.s4 }]}
                          value={fields[f.key] || ''}
                          onChangeText={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))}
                          placeholder={t(f.hintKey)}
                          placeholderTextColor={c.fgSubtle}
                          multiline={multiline}
                          textAlignVertical={multiline ? 'top' : 'center'}
                          accessibilityLabel={t(f.labelKey)}
                        />
                      </View>
                    );
                  })}

                  {/* Auto-included environment — shown so the user knows what's attached */}
                  <View style={s.envCard}>
                    <Text style={s.envLabel}>{t('feedback.body.autoIncluded')}</Text>
                    <Text style={s.envValue}>{envSummary}</Text>
                  </View>

                  {/* Share logs */}
                  <Pressable
                    onPress={() => setIncludeLogs((v) => !v)}
                    style={s.checkRow}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: includeLogs }}
                    accessibilityLabel={t('feedback.logs.label')}
                  >
                    {includeLogs ? (
                      <CheckSquare size={22} color={c.appAccent} strokeWidth={1.5} />
                    ) : (
                      <Square size={22} color={c.fgSubtle} strokeWidth={1.5} />
                    )}
                    <View style={s.checkText}>
                      <Text style={s.checkLabel}>{t('feedback.logs.label')}</Text>
                      <Text style={s.checkHint}>{t('feedback.logs.hint')}</Text>
                    </View>
                  </Pressable>
                  {includeLogs && (
                    <Pressable
                      onPress={() => setPreviewOpen(true)}
                      style={s.previewLink}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('feedback.logs.view')}
                    >
                      <FileText size={14} color={c.fg} strokeWidth={1.5} />
                      <Text style={s.previewLinkText}>{t('feedback.logs.view')}</Text>
                    </Pressable>
                  )}

                  {failed && <Text style={s.error}>{t('feedback.send.failed')}</Text>}
                </ScrollView>

                {/* Footer */}
                <View style={s.footer}>
                  <Pressable
                    onPress={onSend}
                    disabled={sending}
                    style={({ pressed }) => [s.sendBtn, pressed && s.pressed, sending && s.sendBtnDim]}
                    accessibilityRole="button"
                    accessibilityLabel={t('feedback.send.action')}
                  >
                    {sending ? (
                      <ActivityIndicator color={c.inkButtonText} />
                    ) : (
                      <Text style={s.sendBtnText}>{t('feedback.send.action')}</Text>
                    )}
                  </Pressable>
                  <Text style={s.footnote}>{t('feedback.send.note')}</Text>
                </View>
              </KeyboardAvoidingView>
            )}
          </SafeAreaView>
        </View>

        {/* What's shared — the exact attached text, for transparency */}
        <FeedbackLogPreview
          visible={previewOpen}
          onClose={() => setPreviewOpen(false)}
          reduceMotion={reduceMotion}
          report={buildLogReport(diag)}
          c={c}
          s={s}
        />
      </SafeAreaProvider>
    </Modal>
  );
}
