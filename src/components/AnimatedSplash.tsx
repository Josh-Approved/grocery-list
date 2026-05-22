/**
 * Cold-start splash that bridges the native launch screen into the app.
 *
 * The native launch screen shows the app icon (`splash-icon.png`) contained on
 * paper. This component renders that *same* asset the same way, so when the
 * native splash hands off to JS there is no visible cut — then the Josh Approved
 * approval-green check lands over the icon and the whole layer fades into the app.
 *
 * Always paper/light, on purpose: the native launch screen is locked light
 * (app.json `splash.backgroundColor`), so matching it is what makes the handoff
 * seamless. The exit crossfade absorbs the paper -> app (incl. dark) transition.
 *
 * Two variants for comparison — flip SPLASH_VARIANT and the dev app hot-reloads:
 *   'calm'   — static check fades + gently scales to rest (on-brand default).
 *   'drawOn' — the check draws itself stroke-by-stroke (a deliberate exception
 *              to the design system, which lists draw-on checkmarks under
 *              "things to refuse"; kept here only so Josh can compare).
 *
 * Motion is the system's single ease-out curve, no bounce. Reduce-motion
 * collapses every duration to 0 — the check is simply present.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, Image, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Rect, Polyline } from 'react-native-svg';
import { lightColors } from '../theme';

/** Flip to compare on-device. See file header. */
export const SPLASH_VARIANT: 'calm' | 'drawOn' = 'calm';

const PAPER = lightColors.bg; // #FAFAF7 — matches the native launch screen
const GREEN = lightColors.accent; // #1F8A4C — the approval green

// Single ease-out curve (design-system `motion.easingStandard`). No bounce.
const EASE = Easing.bezier(0.2, 0, 0, 1);

// Timeline (ms). Kept short — the icon-only beat overlaps real cold-start work,
// so the check reads as "arriving" without padding launch.
const T = {
  holdBefore: 140, // icon alone, so it registers before the check
  badgeIn: 240, // calm: fade+scale of the whole check; drawOn: the plate appears
  drawDelay: 110, // drawOn: pause after the plate before the stroke draws
  draw: 300, // drawOn: stroke draw
  holdAfter: 220, // let the finished check sit a beat
  fadeOut: 240, // crossfade the whole layer into the app
};

// Polyline path length (two segments of the check) + slack for round caps.
const CHECK_DASH = 24;

// The native launch screen shows the icon contained full-screen. For a square
// asset that's a centered square the size of the screen's shorter edge — render
// it explicitly so the result is identical on iOS/Android and deterministic on
// web. The approval check is a corner stamp on the lower-right of that icon
// (matching the corner-check convention used elsewhere in the catalogue).
const { width: WIN_W, height: WIN_H } = Dimensions.get('window');
const ICON = Math.round(Math.min(WIN_W, WIN_H));
const BADGE = Math.round(ICON * 0.24);
// Offset of the badge centre from the icon centre, toward the lower-right
// corner. Keeps the badge on the icon, clear of its rounded corner.
const CORNER_OFFSET = Math.round(ICON * 0.21);

const AnimatedPolyline = Animated.createAnimatedComponent(Polyline);

type Props = {
  /** App content is mounted and ready (fonts + stores hydrated). */
  ready: boolean;
  /** Called once the layer has fully faded out — unmount the splash then. */
  onFinish: () => void;
};

export default function AnimatedSplash({ ready, onFinish }: Props) {
  const reduceMotion = useReducedMotion();

  const badgeOpacity = useSharedValue(reduceMotion ? 1 : 0);
  const badgeScale = useSharedValue(reduceMotion ? 1 : 0.8);
  // Normalized stroke offset: 1 = undrawn, 0 = fully drawn.
  const checkDraw = useSharedValue(
    reduceMotion || SPLASH_VARIANT === 'calm' ? 0 : 1,
  );
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

    badgeOpacity.value = withDelay(
      T.holdBefore,
      withTiming(1, { duration: SPLASH_VARIANT === 'calm' ? T.badgeIn : 150, easing: EASE }),
    );
    badgeScale.value = withDelay(
      T.holdBefore,
      withTiming(1, { duration: SPLASH_VARIANT === 'calm' ? T.badgeIn : 150, easing: EASE }),
    );

    let introMs = T.holdBefore;
    if (SPLASH_VARIANT === 'calm') {
      introMs += T.badgeIn + T.holdAfter;
    } else {
      checkDraw.value = withDelay(
        T.holdBefore + T.drawDelay,
        withTiming(0, { duration: T.draw, easing: EASE }),
      );
      introMs += T.drawDelay + T.draw + T.holdAfter;
    }
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
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: badgeOpacity.value,
    transform: [{ scale: badgeScale.value }],
  }));
  const checkProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_DASH * checkDraw.value,
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
      <Badge style={badgeStyle} checkProps={checkProps} />
    </Animated.View>
  );
}

function Badge({
  style,
  checkProps,
}: {
  style: ReturnType<typeof useAnimatedStyle>;
  checkProps: ReturnType<typeof useAnimatedProps>;
}) {
  return (
    <View style={styles.badgeWrap}>
      <View style={styles.badgeCorner}>
        <Animated.View style={style}>
          <Svg width={BADGE} height={BADGE} viewBox="0 0 36 36">
          {/* Paper plate so the green check reads as a stamp on the icon. */}
          <Rect x={0} y={0} width={36} height={36} rx={9} fill={PAPER} />
          <Rect x={4} y={4} width={28} height={28} rx={6} fill={GREEN} />
          <AnimatedPolyline
            points="11,19 16,24 25,13"
            fill="none"
            stroke={PAPER}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={CHECK_DASH}
            animatedProps={checkProps}
          />
          </Svg>
        </Animated.View>
      </View>
    </View>
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
  badgeWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  // Shift the badge from the icon centre toward the lower-right corner. Scale
  // animates on the inner Animated.View, so it stays anchored at the badge.
  badgeCorner: {
    transform: [
      { translateX: CORNER_OFFSET },
      { translateY: CORNER_OFFSET },
    ],
  },
});
