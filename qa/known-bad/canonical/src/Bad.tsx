// KNOWN-BAD FIXTURE — do not "fix" these. Each line trips a specific
// qa-canonical FAIL rule so prove-gates can prove the rule is a live sensor.
// This file is NEVER compiled or bundled (excluded from tsconfig + jest); it is
// only ever read as text by scripts/qa-canonical.mjs. See ../../README.md.
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, Text, View } from 'react-native';
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

// a11y/scalable-line-height: a bare numeric lineHeight. RN scales fontSize by the
// OS text setting but never a literal lineHeight, so at AX sizes the glyphs grow
// past this 20px box and the lines collide, then clip.
const textStyles = {
  body: { fontSize: 16, lineHeight: 20 },
};

// i18n/no-hardcoded-strings would also fire here, but the fixture omits src/i18n
// entirely so that rule fails on the missing module (a stronger, simpler signal).
export function Screen({ list }: { list: { name: string } }) {
  return (
    <View style={styles.label}>
      <Text style={textStyles.body}>Rename list</Text>
      {/* a11y/no-truncated-user-content: the user's own list name clamped to one
          line — the bigger they set their text, the less of it they can read. */}
      <Text numberOfLines={1}>{list.name}</Text>
      {/* a11y/reduced-motion-guarded: a literal animationType always animates,
          so switching Reduce Motion on does nothing to this sheet. */}
      <Modal visible transparent animationType="slide">
        <Text>Edit</Text>
      </Modal>
      {/* a11y/voice-control-name-match: the button READS "Save" but its label
          starts with "Store" — a Voice Control user says "tap Save" and nothing
          happens, because iOS matches the spoken phrase against the LABEL. The
          real fleet's version of this bug is subtler and per-locale (German and
          Japanese put the verb last, so the visible word lands at the END of the
          label); a literal pair is used here because the fixture has no i18n. */}
      <Pressable accessibilityLabel="Store this timer" onPress={() => {}}>
        <Text>Save</Text>
      </Pressable>
    </View>
  );
}
