// Styles for the canonical tip-jar sheet, split out of TipJarSheet.tsx to keep
// it under the component size ceiling.
// Source: josh-approved-factory/templates/tip-jar/tipJarStyles.ts
// Synced by `sync.mjs tip-jar` alongside TipJarSheet.tsx; do not fork.

import { StyleSheet } from 'react-native';
import { fontFamily, space, radius, type as ty, hairline, Colors } from '../theme';

export function makeStyles(c: Colors) {
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
      maxWidth: 420,
      backgroundColor: c.bgElevated,
      borderRadius: radius.lg,
      borderWidth: hairline,
      borderColor: c.hairline,
      padding: space.s7,
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.18,
      shadowRadius: 16,
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
      color: c.fg,
      textAlign: 'center',
      marginBottom: space.s6,
    },
    statusBlock: {
      paddingVertical: space.s6,
      alignItems: 'center',
      width: '100%',
    },
    unavailable: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
    },
    tierList: { width: '100%', maxHeight: 320 },
    tierListContent: { gap: space.s3 },
    tierBtn: {
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
      paddingVertical: space.s4,
      paddingHorizontal: space.s7,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
    },
    tierBtnDimmed: { opacity: 0.4 },
    tierBtnText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
    primaryBtn: {
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
      paddingVertical: space.s4,
      paddingHorizontal: space.s7,
      width: '100%',
      alignItems: 'center',
      marginTop: space.s4,
    },
    primaryBtnText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
    secondaryBtn: { paddingVertical: space.s2, marginTop: space.s4 },
    secondaryBtnText: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
    },
    pressed: { opacity: 0.7 },
  });
}
