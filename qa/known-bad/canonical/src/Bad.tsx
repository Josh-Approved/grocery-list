// KNOWN-BAD FIXTURE — do not "fix" these. Each line trips a specific
// qa-canonical FAIL rule so prove-gates can prove the rule is a live sensor.
// This file is NEVER compiled or bundled (excluded from tsconfig + jest); it is
// only ever read as text by scripts/qa-canonical.mjs. See ../../README.md.
import { ActionSheetIOS, Alert, Platform, Text, View } from 'react-native';
import { c } from './theme/colors';

// parity/no-platform-early-return: gates whether the feature exists per platform.
export function openMenu() {
  if (Platform.OS !== 'ios') return;
  // parity/no-ios-only-imports: ActionSheetIOS has no Android equivalent.
  ActionSheetIOS.showActionSheetWithOptions({ options: ['Rename', 'Cancel'] }, () => {});
}

// parity/no-alert-prompt: Alert.prompt is undefined on Android.
export function rename() {
  Alert.prompt('New name', '', () => {});
}

// theme/contrast-pairing (check A): c.fgOnInk is paper in BOTH palettes — it has
// no correct inverting background, so it goes invisible on the flipped dark button.
const styles = {
  label: { color: c.fgOnInk },
};

// i18n/no-hardcoded-strings would also fire here, but the fixture omits src/i18n
// entirely so that rule fails on the missing module (a stronger, simpler signal).
export function Screen() {
  return <View style={styles.label}><Text>Rename list</Text></View>;
}
