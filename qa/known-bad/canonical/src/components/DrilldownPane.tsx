// KNOWN-BAD FIXTURE — do not "fix" this. It is the PRE-FIX canonical
// DrilldownSheet pane: an absolutely-positioned full-cover overlay that renders
// its own ScreenHeader (back chevron + title) and never reads safe-area insets.
// The screen's <SafeAreaView> applies insets as PADDING, and padding never
// reaches an absolutely-positioned child, so on a notched iPhone this header
// draws under the status bar / Dynamic Island (tend's drill-downs, 2026-07-27).
// Trips: rn/absolute-pane-safe-area (FAIL — the fixture baseline sets
// "absolute-pane/enforce"). Deliberately trips nothing else — the real pane's
// accessibilityViewIsModal is omitted so a11y/pane-focus stays quiet and this
// fixture proves exactly one sensor. This file is NEVER compiled or bundled; it
// is only ever read as text by scripts/qa-canonical.mjs. See ../../../README.md.
import { Animated, StyleSheet } from 'react-native';
import { ScreenHeader } from './ScreenHeader';

export function DrilldownPane({ title, onClose, children }) {
  return (
    <Animated.View style={styles.pane}>
      <ScreenHeader title={title} onBack={onClose} />
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pane: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#FFFFFF',
    zIndex: 10,
    elevation: 10,
  },
});
