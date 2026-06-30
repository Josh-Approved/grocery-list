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
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  AccessibilityInfo,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  Bug,
  Sparkles,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  X,
  CheckSquare,
  Square,
  FileText,
} from 'lucide-react-native';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  target,
  hairline,
  type as ty,
  type Colors,
} from '../theme';
import { t } from '../i18n';
import { collectDiagnostics } from './diagnostics';
import { buildLogReport } from './compose';
import { sendFeedback, FIELDS, type FeedbackType } from './compose';

type Props = {
  visible: boolean;
  initialType?: FeedbackType;
  onClose: () => void;
};

const TYPES: { type: FeedbackType; icon: typeof Bug; titleKey: string; descKey: string }[] = [
  { type: 'bug', icon: Bug, titleKey: 'feedback.type.bug', descKey: 'feedback.type.bugDesc' },
  { type: 'feature', icon: Sparkles, titleKey: 'feedback.type.feature', descKey: 'feedback.type.featureDesc' },
  { type: 'general', icon: MessageSquare, titleKey: 'feedback.type.general', descKey: 'feedback.type.generalDesc' },
];

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
              <Text style={s.headerTitle} numberOfLines={1}>
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
              <ScrollView contentContainerStyle={s.pickerBody}>
                <Text style={s.pickerLead}>{t('feedback.lead')}</Text>
                {TYPES.map(({ type: tp, icon: Icon, titleKey, descKey }) => (
                  <Pressable
                    key={tp}
                    onPress={() => chooseType(tp)}
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
        <Modal
          visible={previewOpen}
          animationType={reduceMotion ? 'none' : 'slide'}
          onRequestClose={() => setPreviewOpen(false)}
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
                    onPress={() => setPreviewOpen(false)}
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
                    {buildLogReport(diag)}
                  </Text>
                </ScrollView>
              </SafeAreaView>
            </View>
          </SafeAreaProvider>
        </Modal>
      </SafeAreaProvider>
    </Modal>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    backdrop: { flex: 1, backgroundColor: c.bgScrim },
    sheet: { flex: 1, backgroundColor: c.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.s4,
      paddingVertical: space.s3,
      borderBottomWidth: hairline,
      borderBottomColor: c.hairline,
    },
    headerBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      flex: 1,
      textAlign: 'center',
    },

    // Step 1 — picker
    pickerBody: { padding: space.s5, gap: space.s4 },
    pickerLead: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      marginBottom: space.s1,
    },
    typeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s4,
      padding: space.s4,
      borderRadius: radius.md,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      backgroundColor: c.bgElevated,
    },
    typeIcon: {
      width: 40,
      height: 40,
      borderRadius: radius.sm,
      backgroundColor: c.appAccentBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    typeText: { flex: 1, gap: space.s1 },
    typeTitle: { ...ty.base, fontFamily: fontFamily.sansMedium, color: c.fg },
    typeDesc: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted },

    // Step 2 — form
    formBody: { padding: space.s5, gap: space.s5, paddingBottom: space.s7 },
    tipCard: {
      padding: space.s4,
      borderRadius: radius.md,
      backgroundColor: c.bgSubtle,
      gap: space.s2,
    },
    tipTitle: { ...ty.sm, fontFamily: fontFamily.sansSemibold, color: c.fg },
    tipBody: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted },
    field: { gap: space.s2 },
    label: { ...ty.sm, fontFamily: fontFamily.sansSemibold, color: c.fg },
    input: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fg,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      borderRadius: radius.md,
      paddingHorizontal: space.s4,
      paddingVertical: space.s3,
      backgroundColor: c.bgElevated,
      minHeight: target.min,
    },
    envCard: {
      padding: space.s4,
      borderRadius: radius.md,
      backgroundColor: c.bgSubtle,
      gap: space.s1,
    },
    envLabel: {
      ...ty.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    envValue: { ...ty.sm, fontFamily: fontFamily.mono, color: c.fg },
    checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s3 },
    checkText: { flex: 1, gap: space.s1 },
    checkLabel: { ...ty.base, fontFamily: fontFamily.sansMedium, color: c.fg },
    checkHint: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted },
    previewLink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
      paddingVertical: space.s1,
      marginLeft: 22 + space.s3,
    },
    previewLinkText: { ...ty.sm, fontFamily: fontFamily.sansMedium, color: c.fg, textDecorationLine: 'underline' },
    error: { ...ty.sm, fontFamily: fontFamily.sans, color: c.danger },

    footer: {
      paddingHorizontal: space.s5,
      paddingTop: space.s3,
      paddingBottom: space.s4,
      borderTopWidth: hairline,
      borderTopColor: c.hairline,
      gap: space.s2,
    },
    sendBtn: {
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
      minHeight: 48,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendBtnDim: { opacity: 0.5 },
    sendBtnText: { ...ty.base, fontFamily: fontFamily.sansSemibold, color: c.inkButtonText },
    footnote: { ...ty.xs, fontFamily: fontFamily.sans, color: c.fgSubtle, textAlign: 'center' },

    // Preview
    previewLead: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      paddingHorizontal: space.s5,
      paddingTop: space.s4,
    },
    previewBody: { padding: space.s5 },
    previewText: { ...ty.xs, fontFamily: fontFamily.mono, color: c.fg },

    pressed: { opacity: 0.6 },
  });
}
