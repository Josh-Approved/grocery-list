/**
 * The canonical app shell — the chrome that wraps every Josh Approved app:
 * gesture root, safe-area provider, error boundary, the themed
 * NavigationContainer + status bar, and the cold-start splash overlay. Removes
 * ~40 lines of identical boilerplate that used to live in every App.tsx.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * Usage in App.tsx (the app owns only the readiness gate + the screen list):
 *
 *   <AppShell ready={fontsLoaded && hydrated} navigationRef={navigationRef}>
 *     <Stack.Navigator screenOptions={{ headerShown: false }}>
 *       <Stack.Screen name="Home" component={HomeScreen} />
 *       ...
 *     </Stack.Navigator>
 *   </AppShell>
 *
 * Keep `SplashScreen.preventAutoHideAsync()` at module scope in App.tsx (it
 * must run before first paint); AppShell owns hiding it via AnimatedSplash.
 */

import React, { useState } from 'react';
import { useColorScheme } from 'react-native';
import {
  NavigationContainer,
  type NavigationContainerRef,
} from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ErrorBoundary } from '../components/ErrorBoundary';
import AnimatedSplash from '../components/AnimatedSplash';
import { FeedbackProvider } from '../feedback/FeedbackProvider';
import { buildNavTheme } from './navTheme';
import { useApplyThemePreference } from '../theme';
import { useApplyLocalePreference, useLocaleVersion } from '../i18n/localePreference';
import { QA_MODE } from '../qa/qaMode';

type Props = {
  /** Content is ready (fonts loaded + stores hydrated). Until true, the splash
   *  holds and the navigator is not mounted. */
  ready: boolean;
  /** The navigator tree (a <Stack.Navigator> with the app's screens). */
  children: React.ReactNode;
  /** Optional navigation ref for deep-linking / share-link pairing. */
  navigationRef?: React.Ref<NavigationContainerRef<any>>;
};

export function AppShell({ ready, children, navigationRef }: Props) {
  // Restore + apply the saved appearance preference (System/Light/Dark) once,
  // before first paint. Drives useColorScheme() below and in every screen.
  useApplyThemePreference();
  // Restore + apply the saved language (System, or a locale the user chose). The
  // version keys <NavigationContainer> below so an explicit switch re-renders the
  // whole tree in the new language (canon § Translations). System needs no
  // remount — the device locale is applied on i18n import.
  useApplyLocalePreference();
  const localeVersion = useLocaleVersion();
  const isDark = useColorScheme() === 'dark';
  const [splashDone, setSplashDone] = useState(false);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          {ready && (
            <NavigationContainer key={localeVersion} ref={navigationRef} theme={buildNavTheme(isDark)}>
              <StatusBar style={isDark ? 'light' : 'dark'} />
              <FeedbackProvider>{children}</FeedbackProvider>
            </NavigationContainer>
          )}
          {!QA_MODE && !splashDone && (
            <AnimatedSplash ready={ready} onFinish={() => setSplashDone(true)} />
          )}
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
