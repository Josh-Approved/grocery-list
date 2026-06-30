/**
 * Pull-to-reveal funding footer wiring (canon § Funding & feedback).
 *
 * Makes the bottom-of-screen FundingFooter (a) rest at the bottom of the SCROLL
 * — the last thing in the list/scrollview, pinned to the bottom on a short
 * screen via flexGrow + marginTop:auto — and (b) play the "josh approved"
 * wordmark's splash pop when the user over-pulls past the bottom edge (the same
 * mark + motion as the cold-start splash, re-keyed to the pull).
 *
 * The SAME gesture on both platforms (canon § Cross-platform functional parity):
 *
 * - iOS drives the reveal from the native bottom-bounce, read off the scroll
 *   handler (`over = contentOffset.y + layoutMeasurement.height - contentSize`).
 * - Android scroll views don't report over-pull past the bottom — there's no
 *   native bounce, and the stretch/glow overscroll clamps `contentOffset` (it
 *   fires no scroll events at all past the edge — verified on-device). A plain
 *   PanResponder can't help either: at the bottom of a *scrollable* list the
 *   native scroll view owns the touch and refuses to relinquish it, so the JS
 *   responder is never granted. So Android drives the reveal from a
 *   react-native-gesture-handler `Gesture.Pan()` composed *simultaneously* with
 *   the scroll view's own `Gesture.Native()` — both recognise at once, so when
 *   the list is at the bottom (scroll clamped, nothing left to move) the pan
 *   keeps reporting the extra downward drag. We accumulate that past-bottom drag
 *   into `reveal` with rubber-band resistance and spring it back to 0 on
 *   release, mirroring the iOS bounce. No responder is stolen and normal
 *   scrolling is untouched (the pan only feeds `reveal` while `atBottom`).
 *
 * Reduced-motion falls back to `pullToReveal = false`, where FundingFooter shows
 * the wordmark statically — the lockup is always present; the pop is the
 * enhancement, never a gated feature. The pan is `.enabled(false)` on iOS and
 * under reduced-motion, so the GestureDetector is inert there.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork. The
 * Android path needs react-native-gesture-handler (a peer of every app shell)
 * and a `<GestureHandlerRootView>` at the app root.
 *
 * Usage on a scrollable main screen (the scroll component must be an Animated.*
 * variant so the reanimated `onScroll` handler attaches — Animated.FlatList /
 * Animated.ScrollView / Animated.createAnimatedComponent(SectionList); the
 * SortableList already takes a reanimated onScroll; use `onScrollJS` on a stock
 * RN scroll component). Wrap the scroll component in the GestureDetector and
 * feed it the layout/content size so the pull engages even on a short list:
 *
 *   const {
 *     pullToReveal, reveal, gesture, onScroll,
 *     onScrollViewLayout, onContentSizeChange, footerHeight, onFooterLayout,
 *   } = usePullRevealFooter();
 *   ...
 *   <GestureDetector gesture={gesture}>
 *     <Animated.FlatList
 *       onScroll={pullToReveal ? onScroll : undefined}
 *       scrollEventThrottle={16}
 *       alwaysBounceVertical={pullToReveal}       // bounce a short list (iOS)
 *       overScrollMode="never"                     // no competing stretch (Android)
 *       onLayout={onScrollViewLayout}              // viewport height
 *       onContentSizeChange={onContentSizeChange}  // ⇒ at-bottom on a short list
 *       contentContainerStyle={[s.list, { flexGrow: 1 }]}
 *       ListFooterComponent={
 *         <View style={{ marginTop: 'auto' }} onLayout={onFooterLayout}>
 *           <FundingFooter reveal={reveal} pullToReveal={pullToReveal} onSupport={...} />
 *         </View>
 *       }
 *     />
 *   </GestureDetector>
 *   // Any floating action button lifts to sit just above the footer:
 *   <Pressable style={[s.fab, { bottom: footerHeight + space.s4 }]} ... />
 */

import { useCallback, useState } from 'react';
import {
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {
  Gesture,
  type ComposedGesture,
} from 'react-native-gesture-handler';
import {
  Easing,
  useReducedMotion,
  useSharedValue,
  useAnimatedScrollHandler,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

// Pixels of over-pull past the bottom for the wordmark to fully pop in (iOS,
// read off the resisted native bounce).
const REVEAL_DISTANCE = 88;
// Android: raw finger travel past the bottom is unresisted, so we apply our own
// rubber-band. RESIST_SCALE sets how far you pull before fully revealed — at
// 2.2 you drag ~190px of finger for the last of the reveal, matching the feel
// of the iOS resisted bounce rather than a 1:1 drag.
const RESIST_SCALE = 2.2;
// Ignore sub-finger jitter before treating a drag as an over-pull.
const PULL_SLOP = 6;
// You're "at the bottom" within this many px of the content's end.
const BOTTOM_EPS = 2;
// Single ease-out curve (design-system motion.easingStandard) — matches the
// splash pop; the wordmark recedes on the same curve it arrived on.
const RELEASE = { duration: 320, easing: Easing.bezier(0.2, 0, 0, 1) };

export type PullRevealFooter = {
  /** True when the pull-to-reveal pop should play (both platforms); false under
   *  reduced-motion, where FundingFooter shows the wordmark statically. */
  pullToReveal: boolean;
  /** 0→1 reveal progress; pass to <FundingFooter reveal=… />. */
  reveal: SharedValue<number>;
  /** Gesture for a <GestureDetector> wrapping the scroll component — the Android
   *  over-pull. Inert on iOS / under reduced-motion (the pan is disabled), so
   *  the GestureDetector can wrap unconditionally. */
  gesture: ComposedGesture;
  /** UI-thread scroll handler — attach to an Animated.* scroll component
   *  (Animated.FlatList / Animated.ScrollView) or a SortableList. Drives the
   *  reveal from bottom-overscroll on iOS; feeds at-bottom detection on both. */
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  /** Plain onScroll callback — use on a stock RN scroll component (SectionList /
   *  FlatList / ScrollView) when wrapping it in Animated.* is awkward; needs
   *  scrollEventThrottle={16}. */
  onScrollJS: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** onLayout for the scroll component — its height is the scroll viewport, used
   *  to tell a short (non-scrollable) list from a scrollable one. */
  onScrollViewLayout: (e: LayoutChangeEvent) => void;
  /** onContentSizeChange for the scroll component — feeds at-bottom detection so
   *  the pull engages on a short list that never fires onScroll. */
  onContentSizeChange: (w: number, h: number) => void;
  /** Measured footer height — offset a floating action button by this. */
  footerHeight: number;
  /** onLayout for the footer holder; feeds footerHeight. */
  onFooterLayout: (e: LayoutChangeEvent) => void;
};

export function usePullRevealFooter(): PullRevealFooter {
  const reduceMotion = useReducedMotion();
  const pullToReveal = !reduceMotion;
  const androidPull = pullToReveal && Platform.OS === 'android';

  const reveal = useSharedValue(0);
  // Raw metrics as plain numbers (not a derived boolean) — the pan worklet
  // decides at-bottom from these live on the UI thread, so there's no
  // cross-thread boolean to go stale. `scrollOver` = last value of
  // (offset + viewport − content): 0 at the bottom, negative above it, and far
  // negative until the first scroll (so a scrollable list reads "not at bottom"
  // at the top). content/viewport feed the short-list (non-scrollable) case.
  const scrollOver = useSharedValue(-1e7);
  const contentH = useSharedValue(0);
  const viewportH = useSharedValue(0);
  // translationY captured when the drag first reaches the bottom, so the reveal
  // measures only the drag PAST the bottom (not the scroll that got us there).
  const anchorY = useSharedValue(-1);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      const over =
        e.contentOffset.y + e.layoutMeasurement.height - e.contentSize.height;
      scrollOver.value = over;
      // iOS reads the reveal straight off the resisted native bounce. On Android
      // `over` clamps at 0, so the pan owns the reveal — don't fight it.
      if (Platform.OS === 'ios') {
        const p = over / REVEAL_DISTANCE;
        reveal.value = p < 0 ? 0 : p > 1 ? 1 : p;
      }
    },
  });

  const onScrollJS = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      const over =
        contentOffset.y + layoutMeasurement.height - contentSize.height;
      scrollOver.value = over;
      if (Platform.OS === 'ios') {
        const p = over / REVEAL_DISTANCE;
        reveal.value = p < 0 ? 0 : p > 1 ? 1 : p;
      }
    },
    [reveal, scrollOver]
  );

  const onScrollViewLayout = useCallback(
    (e: LayoutChangeEvent) => {
      viewportH.value = e.nativeEvent.layout.height;
    },
    [viewportH]
  );
  const onContentSizeChange = useCallback(
    (_w: number, h: number) => {
      contentH.value = h;
    },
    [contentH]
  );

  // The pan recognises simultaneously with the scroll view's own gesture, so
  // normal scrolling is untouched; the pan only feeds `reveal` while at bottom.
  const gesture = Gesture.Simultaneous(
    Gesture.Native(),
    Gesture.Pan()
      .enabled(androidPull)
      .onBegin(() => {
        anchorY.value = -1;
      })
      .onUpdate((e) => {
        // Decide at-bottom live on the UI thread from raw metrics: a short
        // (non-scrollable) list is always at the bottom; a scrollable one is at
        // the bottom only when the last scroll-over reached the edge.
        const scrollable = contentH.value > viewportH.value + BOTTOM_EPS;
        const atBottom = !scrollable || scrollOver.value >= -BOTTOM_EPS;
        if (!atBottom) {
          anchorY.value = -1;
          reveal.value = 0;
          return;
        }
        if (anchorY.value < 0) anchorY.value = e.translationY;
        const d = anchorY.value - e.translationY - PULL_SLOP;
        if (d <= 0) {
          reveal.value = 0;
          return;
        }
        // Rubber-band: ~linear for a small pull, compressing as it grows, so the
        // mark tracks the finger but resists like the iOS bounce.
        const resisted = d / (1 + d / (REVEAL_DISTANCE * RESIST_SCALE));
        const p = resisted / REVEAL_DISTANCE;
        reveal.value = p > 1 ? 1 : p;
      })
      .onFinalize(() => {
        anchorY.value = -1;
        reveal.value = withTiming(0, RELEASE);
      })
  );

  const [footerHeight, setFooterHeight] = useState(96);
  const onFooterLayout = useCallback(
    (e: LayoutChangeEvent) =>
      setFooterHeight(Math.round(e.nativeEvent.layout.height)),
    []
  );

  return {
    pullToReveal,
    reveal,
    gesture,
    onScroll,
    onScrollJS,
    onScrollViewLayout,
    onContentSizeChange,
    footerHeight,
    onFooterLayout,
  };
}
