/**
 * Cold-start splash that bridges the native launch screen into the app.
 *
 * Canonical across the catalogue — synced into each app at
 * src/components/AnimatedSplash.tsx by
 *   node josh-approved-factory/scripts/sync.mjs splash <app>
 * Edit HERE (the factory template), never the per-app copy.
 *
 * The native launch screen shows the app icon glyph (`splash-icon.png`)
 * contained on paper. This component renders that *same* asset the same way, so
 * the native -> JS handoff has no visible cut. Then the "josh approved" wordmark
 * (the same mark that sits at the bottom of every Settings screen) pops in
 * toward the bottom of the screen, and the whole layer crossfades into the app.
 *
 * Always paper/light, on purpose: the native launch screen is locked light
 * (app.json `splash.backgroundColor`), so matching it is what makes the handoff
 * seamless. The exit crossfade absorbs the paper -> app (incl. dark) transition.
 *
 * Motion is the system's single ease-out curve, no bounce — a crisp pop, not a
 * bounce. Reduce-motion collapses every duration to 0 (the mark is just there).
 * Total intro is ~1s — a deliberate launch beat, longer than the 150/250ms UI
 * interaction tokens.
 *
 * Wiring (per app, in App.tsx — see the design-system skill / sync nextSteps):
 *   import * as SplashScreen from 'expo-splash-screen';
 *   SplashScreen.preventAutoHideAsync().catch(() => {});   // module scope
 *   const ready = <app's existing first-paint gate (fonts + any store hydration)>;
 *   const [splashDone, setSplashDone] = useState(false);
 *   // render app content when `ready`; overlay until splashDone:
 *   {!splashDone && <AnimatedSplash ready={ready} onFinish={() => setSplashDone(true)} />}
 */

import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, Image, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { Check } from 'lucide-react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { lightColors, fontFamily, tracking } from '../theme';

const PAPER = lightColors.bg; // #FAFAF7 — matches the native launch screen
const GREEN = lightColors.accent; // #1F8A4C — the approval green (the check)
const INK = lightColors.fg; // wordmark text

// Single ease-out curve (design-system `motion.easingStandard`). No bounce.
const EASE = Easing.bezier(0.2, 0, 0, 1);

// Timeline (ms) — ~1s total, deliberately unhurried but crisp.
const T = {
  holdBefore: 260, // icon alone, so it registers before the mark
  wordIn: 380, // the wordmark pops in (fade + rise + scale-settle)
  holdAfter: 160, // let the finished mark sit a beat
  fadeOut: 240, // crossfade the whole layer into the app
};

const { width: WIN_W, height: WIN_H } = Dimensions.get('window');
// The native launch screen shows the glyph contained full-screen; render it the
// same way (centred square the size of the shorter edge) so the handoff matches.
const ICON = Math.round(Math.min(WIN_W, WIN_H));
// The wordmark sits in the lower portion of the screen, beneath the icon.
const WORDMARK_BOTTOM = Math.round(WIN_H * 0.16);
const CHECK_SIZE = 22;

type Props = {
  /** App content is mounted and ready (fonts + stores hydrated). */
  ready: boolean;
  /** Called once the layer has fully faded out — unmount the splash then. */
  onFinish: () => void;
};

export default function AnimatedSplash({ ready, onFinish }: Props) {
  const reduceMotion = useReducedMotion();

  const wordOpacity = useSharedValue(reduceMotion ? 1 : 0);
  const wordScale = useSharedValue(reduceMotion ? 1 : 0.85);
  const wordY = useSharedValue(reduceMotion ? 0 : 14);
  const layerOpacity = useSharedValue(1);

  const [introDone, setIntroDone] = useState(false);
  const began = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Start the intro the moment the JS layer is on screen, and hand the native
  // launch screen over to it (the two frames are identical, so no flicker).
  const begin = () => {
    if (began.current) return;
    began.current = true;
    SplashScreen.hideAsync().catch(() => {});

    if (reduceMotion) {
      setIntroDone(true);
      return;
    }

    const opts = { duration: T.wordIn, easing: EASE };
    wordOpacity.value = withDelay(T.holdBefore, withTiming(1, opts));
    wordScale.value = withDelay(T.holdBefore, withTiming(1, opts));
    wordY.value = withDelay(T.holdBefore, withTiming(0, opts));

    const introMs = T.holdBefore + T.wordIn + T.holdAfter;
    const id = setTimeout(() => setIntroDone(true), introMs);
    timers.current.push(id);
  };

  // Exit only once the intro has played AND the app behind us is ready.
  useEffect(() => {
    if (!introDone || !ready) return;
    layerOpacity.value = withTiming(
      0,
      { duration: reduceMotion ? 0 : T.fadeOut, easing: EASE },
      (finished) => {
        if (finished) runOnJS(onFinish)();
      },
    );
  }, [introDone, ready, reduceMotion, layerOpacity, onFinish]);

  const layerStyle = useAnimatedStyle(() => ({ opacity: layerOpacity.value }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOpacity.value,
    transform: [{ translateY: wordY.value }, { scale: wordScale.value }],
  }));

  return (
    <Animated.View style={[styles.layer, layerStyle]} onLayout={begin}>
      <StatusBar style="dark" />
      <View style={styles.center}>
        <Image
          source={require('../../assets/splash-icon.png')}
          style={{ width: ICON, height: ICON }}
          resizeMode="contain"
          fadeDuration={0}
        />
      </View>
      <View style={styles.wordmarkWrap}>
        <Animated.View
          style={[styles.row, wordStyle]}
          accessible
          accessibilityRole="text"
          accessibilityLabel="josh approved"
        >
          <Check size={CHECK_SIZE} color={GREEN} strokeWidth={3} />
          <Text style={styles.text} importantForAccessibility="no">
            josh approved
          </Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: PAPER,
    zIndex: 10,
    elevation: 10,
    pointerEvents: 'none',
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  wordmarkWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: WORDMARK_BOTTOM,
    pointerEvents: 'none',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  text: {
    color: INK,
    fontFamily: fontFamily.sansSemibold,
    fontSize: 19,
    letterSpacing: tracking.mark,
  },
});
