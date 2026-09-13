/**
 * Styles, config types and the reduced-motion hook shared by the dialog hooks
 * in `Dialogs.tsx`.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell` alongside
 * Dialogs.tsx; do not fork.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, AccessibilityInfo } from 'react-native';
import { fontFamily, space, radius, target, type as ty, hairline, type Colors } from '../theme';

export interface ActionOption {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export interface MenuState {
  visible: boolean;
  title?: string;
  options: ActionOption[];
}

export interface PromptConfig {
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

export interface PromptState extends PromptConfig {
  visible: boolean;
  value: string;
}

export interface ConfirmConfig {
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export interface ConfirmState extends ConfirmConfig {
  visible: boolean;
}

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

export function makeDialogStyles(c: Colors) {
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
