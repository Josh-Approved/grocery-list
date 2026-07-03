/**
 * Styles for the Send-feedback flow, shared by FeedbackSheet and its two
 * sub-views (FeedbackTypePicker, FeedbackLogPreview). Extracted from
 * FeedbackSheet so each file stays under the component ceiling
 * (engineering-standards.md); the parent builds these once and threads them
 * down as a prop so the children never re-run StyleSheet.create.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 * Inherits the design system from '../theme'; don't restyle per app.
 */

import { StyleSheet } from 'react-native';
import {
  fontFamily,
  space,
  radius,
  target,
  hairline,
  type as ty,
  type Colors,
} from '../theme';

export type FeedbackStyles = ReturnType<typeof makeStyles>;

export function makeStyles(c: Colors) {
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
