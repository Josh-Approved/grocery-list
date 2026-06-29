/**
 * Pull-to-reveal funding footer wiring (canon § Funding & feedback).
 *
 * Makes the bottom-of-screen FundingFooter (a) rest at the bottom of the SCROLL
 * — the last thing in the list/scrollview, pinned to the bottom on a short
 * screen via flexGrow + marginTop:auto — and (b) play the "josh approved"
 * wordmark's splash pop when the user over-pulls past the bottom edge (the same
 * mark + motion as the cold-start splash, re-keyed to the pull).
 *
 * iOS drives the reveal from the native bottom-bounce. Android has no bottom
 * bounce, so `pullToReveal` is false there and FundingFooter shows the wordmark
 * statically — the lockup is present on both platforms; the pop is an iOS
 * enhancement (a presentation difference, never a gated feature).
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * Usage on a scrollable main screen (the scroll component must be an Animated.*
 * variant so the reanimated handler attaches — Animated.FlatList /
 * Animated.ScrollView / Animated.createAnimatedComponent(SectionList); the
 * SortableList already takes a reanimated onScroll):
 *
 *   const { pullToReveal, reveal, onScroll, footerHeight, onFooterLayout } =
 *     usePullRevealFooter();
 *   ...
 *   <Animated.FlatList
 *     onScroll={pullToReveal ? onScroll : undefined}
 *     scrollEventThrottle={16}
 *     alwaysBounceVertical={pullToReveal}        // bounce a short list so the pull is reachable
 *     contentContainerStyle={[s.list, { flexGrow: 1 }]}
 *     ListFooterComponent={
 *       <View style={{ marginTop: 'auto' }} onLayout={onFooterLayout}>
 *         <FundingFooter reveal={reveal} pullToReveal={pullToReveal} onSupport={...} />
 *       </View>
 *     }
 *   />
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
  useSharedValue,
  useAnimatedScrollHandler,
  type SharedValue,
} from 'react-native-reanimated';

// Pixels of over-pull past the bottom for the wordmark to fully pop in.
const REVEAL_DISTANCE = 88;

export type PullRevealFooter = {
  /** True on iOS (native bottom-bounce drives the reveal); false on Android. */
  pullToReveal: boolean;
  /** 0→1 reveal progress; pass to <FundingFooter reveal=… />. */
  reveal: SharedValue<number>;
  /** UI-thread scroll handler — attach to an Animated.* scroll component
   *  (Animated.FlatList / Animated.ScrollView) or a SortableList. */
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  /** Plain onScroll callback — use on a stock RN scroll component (SectionList /
   *  FlatList / ScrollView) when wrapping it in Animated.* is awkward; needs
   *  scrollEventThrottle={16}. Drives the same reveal value from the JS thread. */
  onScrollJS: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Measured footer height — offset a floating action button by this. */
  footerHeight: number;
  /** onLayout for the footer holder; feeds footerHeight. */
  onFooterLayout: (e: LayoutChangeEvent) => void;
};

export function usePullRevealFooter(): PullRevealFooter {
  const pullToReveal = Platform.OS === 'ios';
  const reveal = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      const over =
        e.contentOffset.y + e.layoutMeasurement.height - e.contentSize.height;
      const p = over / REVEAL_DISTANCE;
      reveal.value = p < 0 ? 0 : p > 1 ? 1 : p;
    },
  });
  const onScrollJS = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      const over =
        contentOffset.y + layoutMeasurement.height - contentSize.height;
      const p = over / REVEAL_DISTANCE;
      reveal.value = p < 0 ? 0 : p > 1 ? 1 : p;
    },
    [reveal]
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
    onScroll,
    onScrollJS,
    footerHeight,
    onFooterLayout,
  };
}
