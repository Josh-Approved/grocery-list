/**
 * Cross-platform action menu, text-input prompt, and confirm dialog.
 *
 * Replaces `ActionSheetIOS`, `Alert.prompt`, and `Alert.alert` (all iOS-only or
 * iOS-divergent), so every management flow works identically on both platforms.
 * Studio tenet: functional parity is mandatory; no OS-specific frameworks for
 * core functionality (canon § Cross-platform functional parity).
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * Styling mirrors the canonical ReviewModal (same scrim/card tokens) so every
 * dialog reads as a sibling. Reduced motion collapses the present animation to
 * none (canon § Accessibility, WCAG 2.2 AA).
 *
 * Each hook returns `{ open, element }`: call `open(config)` from a handler,
 * render `element` once in the screen tree.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  AccessibilityInfo,
} from 'react-native';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  target,
  type as ty,
  hairline,
  type Colors,
} from '../theme';
import { t } from '../i18n';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Action menu
// ---------------------------------------------------------------------------

export interface ActionOption {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

interface MenuState {
  visible: boolean;
  title?: string;
  options: ActionOption[];
}

export function useActionMenu(): {
  open: (cfg: { title?: string; options: ActionOption[] }) => void;
  element: React.ReactElement;
} {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();
  const [state, setState] = useState<MenuState>({ visible: false, options: [] });

  const close = useCallback(() => setState((p) => ({ ...p, visible: false })), []);
  const open = useCallback(
    (cfg: { title?: string; options: ActionOption[] }) =>
      setState({ visible: true, title: cfg.title, options: cfg.options }),
    [],
  );
  const choose = useCallback(
    (opt: ActionOption) => {
      close();
      // Let the sheet finish dismissing before the action runs. Native
      // presentations (the OS share sheet, the image picker) are rejected by
      // iOS if they try to present while this Modal is still animating closed,
      // so defer past the slide-out. Harmless for non-presenting actions.
      setTimeout(() => opt.onPress(), 260);
    },
    [close],
  );

  const element = (
    <Modal
      visible={state.visible}
      transparent
      animationType={reduced ? 'none' : 'slide'}
      statusBarTranslucent
      onRequestClose={close}
    >
      <Pressable
        style={s.sheetOverlay}
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel={t('common.closeMenu')}
      >
        <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
          {state.title ? (
            <Text style={s.sheetTitle} accessibilityRole="header">
              {state.title}
            </Text>
          ) : null}
          {state.options.map((opt, i) => (
            <Pressable
              key={`${opt.label}-${i}`}
              style={({ pressed }) => [s.sheetRow, pressed && s.pressed]}
              onPress={() => choose(opt)}
              accessibilityRole="button"
              accessibilityLabel={opt.label}
            >
              <Text style={[s.sheetRowText, opt.destructive && s.sheetRowDanger]}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            style={({ pressed }) => [s.sheetCancel, pressed && s.pressed]}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          >
            <Text style={s.sheetCancelText}>{t('common.cancel')}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );

  return { open, element };
}

// ---------------------------------------------------------------------------
// Text-input prompt
// ---------------------------------------------------------------------------

interface PromptConfig {
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad' | 'email-address';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  /** Select the initial value on focus (rename flows). */
  selectAll?: boolean;
  /** Allow submitting an empty value (e.g. clearing an optional field). */
  allowEmpty?: boolean;
  onSubmit: (text: string) => void;
}

interface PromptState extends PromptConfig {
  visible: boolean;
  value: string;
}

export function usePrompt(): {
  open: (cfg: PromptConfig) => void;
  element: React.ReactElement;
} {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();
  const [state, setState] = useState<PromptState>({
    visible: false,
    title: '',
    value: '',
    onSubmit: () => {},
  });

  const close = useCallback(() => setState((p) => ({ ...p, visible: false })), []);
  const open = useCallback(
    (cfg: PromptConfig) => setState({ ...cfg, visible: true, value: cfg.initialValue ?? '' }),
    [],
  );
  const submit = useCallback(() => {
    const trimmed = state.value.trim();
    if (!trimmed && !state.allowEmpty) return;
    close();
    state.onSubmit(trimmed);
  }, [state, close]);

  const canSubmit = state.allowEmpty || state.value.trim().length > 0;

  const element = (
    <Modal
      visible={state.visible}
      transparent
      animationType={reduced ? 'none' : 'fade'}
      statusBarTranslucent
      onRequestClose={close}
    >
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          style={s.centerOverlay}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel={t('common.cancel')}
        >
          <Pressable style={s.card} onPress={(e) => e.stopPropagation()}>
            <Text style={s.cardTitle} accessibilityRole="header">
              {state.title}
            </Text>
            {state.message ? <Text style={s.cardMessage}>{state.message}</Text> : null}
            <TextInput
              style={s.input}
              value={state.value}
              onChangeText={(value) => setState((p) => ({ ...p, value }))}
              placeholder={state.placeholder}
              placeholderTextColor={c.fgSubtle}
              autoFocus
              keyboardType={state.keyboardType ?? 'default'}
              autoCapitalize={state.autoCapitalize ?? 'sentences'}
              selectTextOnFocus={state.selectAll}
              returnKeyType="done"
              onSubmitEditing={submit}
              accessibilityLabel={state.title}
            />
            <View style={s.cardActions}>
              <Pressable
                style={({ pressed }) => [s.btnGhost, pressed && s.pressed]}
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
              >
                <Text style={s.btnGhostText}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [s.btnPrimary, !canSubmit && s.btnDisabled, pressed && s.pressed]}
                onPress={submit}
                disabled={!canSubmit}
                accessibilityRole="button"
                accessibilityLabel={state.confirmLabel ?? t('common.save')}
              >
                <Text style={s.btnPrimaryText}>{state.confirmLabel ?? t('common.save')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );

  return { open, element };
}

// ---------------------------------------------------------------------------
// Confirm dialog (canon § Interaction safety)
// ---------------------------------------------------------------------------
//
// A titled Cancel / Confirm card for consequential actions. Pass
// `destructive: true` for unrecoverable ones (delete a list, remove a member)
// — the confirm button carries the danger tint so the stakes read at a glance,
// and a mis-tap on the original control costs one extra deliberate tap, not
// the data.

interface ConfirmConfig {
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

interface ConfirmState extends ConfirmConfig {
  visible: boolean;
}

export function useConfirm(): {
  open: (cfg: ConfirmConfig) => void;
  element: React.ReactElement;
} {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();
  const [state, setState] = useState<ConfirmState>({ visible: false, title: '', onConfirm: () => {} });

  const close = useCallback(() => setState((p) => ({ ...p, visible: false })), []);
  const open = useCallback((cfg: ConfirmConfig) => setState({ ...cfg, visible: true }), []);
  const confirm = useCallback(() => {
    close();
    state.onConfirm();
  }, [state, close]);

  const element = (
    <Modal
      visible={state.visible}
      transparent
      animationType={reduced ? 'none' : 'fade'}
      statusBarTranslucent
      onRequestClose={close}
    >
      <Pressable
        style={s.centerOverlay}
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel={t('common.cancel')}
      >
        <Pressable style={s.card} onPress={(e) => e.stopPropagation()}>
          <Text style={s.cardTitle} accessibilityRole="header">
            {state.title}
          </Text>
          {state.message ? <Text style={s.cardMessage}>{state.message}</Text> : null}
          <View style={s.cardActions}>
            <Pressable
              style={({ pressed }) => [s.btnGhost, pressed && s.pressed]}
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
            >
              <Text style={s.btnGhostText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.btnPrimary, state.destructive && s.btnDanger, pressed && s.pressed]}
              onPress={confirm}
              accessibilityRole="button"
              accessibilityLabel={state.confirmLabel ?? t('common.confirm')}
            >
              <Text style={[s.btnPrimaryText, state.destructive && s.btnDangerText]}>
                {state.confirmLabel ?? t('common.confirm')}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );

  return { open, element };
}

// ---------------------------------------------------------------------------

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    pressed: { opacity: 0.6 },

    sheetOverlay: { flex: 1, backgroundColor: c.bgScrim, justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: c.bgElevated,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderWidth: hairline,
      borderColor: c.hairline,
      paddingVertical: space.s4,
      paddingBottom: space.s7,
    },
    sheetTitle: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted, textAlign: 'center', paddingVertical: space.s4 },
    sheetRow: { minHeight: target.min, justifyContent: 'center', paddingHorizontal: space.s7, paddingVertical: space.s4 },
    sheetRowText: { ...ty.base, fontFamily: fontFamily.sans, color: c.fg, textAlign: 'center' },
    sheetRowDanger: { color: c.danger },
    sheetCancel: {
      minHeight: target.min,
      justifyContent: 'center',
      marginTop: space.s3,
      marginHorizontal: space.s5,
      borderTopWidth: hairline,
      borderTopColor: c.hairline,
      paddingTop: space.s4,
    },
    sheetCancelText: { ...ty.base, fontFamily: fontFamily.sansSemibold, color: c.fgMuted, textAlign: 'center' },

    centerOverlay: { flex: 1, backgroundColor: c.bgScrim, justifyContent: 'center', alignItems: 'center', padding: space.s7 },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: c.bgElevated,
      borderRadius: radius.lg,
      borderWidth: hairline,
      borderColor: c.hairline,
      padding: space.s7,
    },
    cardTitle: { ...ty.md, fontFamily: fontFamily.sansSemibold, color: c.fg, marginBottom: space.s3 },
    cardMessage: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted, marginBottom: space.s4 },
    input: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fg,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      borderRadius: radius.md,
      paddingHorizontal: space.s5,
      paddingVertical: space.s4,
      minHeight: target.min,
      marginBottom: space.s6,
    },
    cardActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
    btnGhost: { minHeight: target.min, justifyContent: 'center', paddingHorizontal: space.s5, marginRight: space.s3 },
    btnGhostText: { ...ty.base, fontFamily: fontFamily.sans, color: c.fgMuted },
    btnPrimary: { minHeight: target.min, justifyContent: 'center', backgroundColor: c.inkButton, borderRadius: radius.md, paddingHorizontal: space.s7 },
    btnPrimaryText: { ...ty.base, fontFamily: fontFamily.sansSemibold, color: c.inkButtonText },
    btnDanger: { backgroundColor: c.dangerBg },
    btnDangerText: { color: c.danger },
    btnDisabled: { opacity: 0.4 },
  });
}
