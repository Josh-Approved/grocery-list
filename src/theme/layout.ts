// Canonical Josh Approved layout primitives.
// Synced verbatim into each app at src/theme/layout.ts by
// `sync.mjs design-system-native`. Edit the canonical file here, not per app.

import type { ViewStyle } from 'react-native';

/**
 * Maximum width of a single readable content column.
 *
 * Studio apps are phone-shaped single-column layouts. On a phone this is wider
 * than the screen, so it's a no-op. On a tablet (`ios.supportsTablet: true`)
 * it caps the app's persistent surfaces — header, scroll content, sticky
 * bottom bars — at a comfortable reading width so content doesn't stretch
 * into very wide inputs / rows / line lengths. Screen-anchored overlays
 * (FABs, transient snackbars) intentionally stay at the screen edge — that's
 * conventional on any size.
 */
export const CONTENT_MAX_WIDTH = 640;

/**
 * Style fragment: cap an element to {@link CONTENT_MAX_WIDTH} and center it
 * within its parent. Spread into the style keys for the surfaces above:
 *
 *     header: { ...boundedContent, paddingHorizontal: space.s5, ... }
 *
 * Works on plain Views and on `contentContainerStyle` of a vertical
 * ScrollView / FlatList. No JSX changes required.
 */
export const boundedContent: ViewStyle = {
  width: '100%',
  maxWidth: CONTENT_MAX_WIDTH,
  alignSelf: 'center',
};
