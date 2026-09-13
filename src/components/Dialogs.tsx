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
 * Shared styles, config types and the reduced-motion hook live in
 * `dialogShared.ts` (split out
 * to keep this file under the component size ceiling); the pressables stay
 * here so their action-coverage ids don't move.
 *
 * Each hook returns `{ open, element }`: call `open(config)` from a handler,
 * render `element` once in the screen tree.
 */

import React, { useCallback, useState } from 'react';
import { Modal, View, Text, Pressable, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useTheme } from '../theme';
import { t } from '../i18n';
import {
  makeDialogStyles as makeStyles,
  useReducedMotion,
  type ActionOption,
  type MenuState,
  type PromptConfig,
  type PromptState,
  type ConfirmConfig,
  type ConfirmState,
} from './dialogShared';

// Re-exported: app screens import these from here.
export { useReducedMotion, type ActionOption };

// ---------------------------------------------------------------------------
// Action menu
// ---------------------------------------------------------------------------

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
              placeholderTextColor={c.fgMuted}
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
