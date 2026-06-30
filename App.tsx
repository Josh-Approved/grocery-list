/**
 * App root.
 *
 * Two-screen stack: ListsHome (root) + ListDetail. State lives in
 * useListsStore (Zustand) over SQLite (src/store/db.ts); the store loads
 * lists on mount and persists every change in the background.
 *
 * Render gates on useAppFonts (IBM Plex loaded before first paint) AND the
 * store's hydrated flag (so a populated database doesn't flash an empty
 * "no lists yet" state on launch).
 *
 * Settings + the shared-sync entry points land at build steps 6 and 4.
 */

import React, { useEffect, useState } from 'react';
import { useColorScheme, Linking, AppState } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import {
  NavigationContainer,
  createNavigationContainerRef,
  DefaultTheme,
  DarkTheme,
  type Theme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ListChecks, Boxes } from 'lucide-react-native';
import {
  useAppFonts,
  lightColors,
  darkColors,
  typography,
  hairline,
  useApplyThemePreference,
} from './src/theme';
import { useApplyLocalePreference, useLocaleVersion } from './src/i18n/localePreference';
import { useListsStore } from './src/store/lists';
import { useKitsStore } from './src/store/kits';
import { useAccountStore } from './src/store/account';
import ListsHomeScreen from './src/screens/ListsHomeScreen';
import ListDetailScreen from './src/screens/ListDetailScreen';
import KitsHomeScreen from './src/screens/KitsHomeScreen';
import KitDetailScreen from './src/screens/KitDetailScreen';
import ReorderAislesScreen from './src/screens/ReorderAislesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ShareScreen from './src/screens/ShareScreen';
import Credits from './src/components/Credits';
import { startSyncEngine, stopSyncEngine, flushSyncEngine } from './src/sync';
import { parseShareLink } from './src/sync/share';
import { t } from './src/i18n';
import AnimatedSplash from './src/components/AnimatedSplash';
import { QA_MODE } from './src/qa/qaMode';

// Hold the native launch screen until the JS splash takes over (no icon blink).
// Skipped under QA_MODE so the e2e screenshot harness sees deterministic frames.
if (!QA_MODE) {
  SplashScreen.preventAutoHideAsync().catch(() => {});
}

export type RootStackParamList = {
  Tabs: undefined;
  ListDetail: { listId: string };
  KitDetail: { kitId: string };
  ReorderAisles: { listId: string };
  Settings: undefined;
  Share: { listId: string };
  Acknowledgements: undefined;
};

/** The two top-level tabs. Lists and Kits sit side by side so a kit is always
 *  one tap away — you build kits here and select them while adding to a list. */
export type TabParamList = {
  ListsTab: undefined;
  KitsTab: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Bottom tab bar — Lists | Kits. Design-system styling: ink for the active
 *  tab, muted ink for inactive (same icon, never two), a hairline top edge,
 *  Plex Sans label. */
function MainTabs() {
  const c = useColorScheme() === 'dark' ? darkColors : lightColors;
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.fg,
        tabBarInactiveTintColor: c.fgMuted,
        tabBarStyle: {
          backgroundColor: c.bg,
          borderTopColor: c.hairline,
          borderTopWidth: hairline,
        },
        tabBarLabelStyle: { fontFamily: typography.body, fontSize: 12 },
      }}
    >
      <Tab.Screen
        name="ListsTab"
        component={ListsHomeScreen}
        options={{
          tabBarLabel: t('tabs.lists'),
          tabBarAccessibilityLabel: t('tabs.lists'),
          tabBarIcon: ({ color, size }) => (
            <ListChecks size={size} color={color} strokeWidth={1.5} />
          ),
        }}
      />
      <Tab.Screen
        name="KitsTab"
        component={KitsHomeScreen}
        options={{
          tabBarLabel: t('tabs.kits'),
          tabBarAccessibilityLabel: t('tabs.kits'),
          tabBarIcon: ({ color, size }) => (
            <Boxes size={size} color={color} strokeWidth={1.5} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

function buildNavTheme(isDark: boolean): Theme {
  const c = isDark ? darkColors : lightColors;
  const base = isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      background: c.bg,
      card: c.bg,
      text: c.fg,
      border: c.hairline,
      primary: c.fg,
    },
    fonts: {
      regular: { fontFamily: typography.body, fontWeight: '400' },
      medium: { fontFamily: typography.bodyEmphasis, fontWeight: '500' },
      bold: { fontFamily: typography.heading, fontWeight: '600' },
      heavy: { fontFamily: typography.heading, fontWeight: '600' },
    },
  };
}

export default function App() {
  // Restore + apply the saved appearance preference (System/Light/Dark) before
  // first paint; drives useColorScheme() here and in every screen.
  useApplyThemePreference();
  // Restore + apply the saved language; the version keys <NavigationContainer>
  // below so a switch re-renders the whole app in the new language (canon
  // § Translations).
  useApplyLocalePreference();
  const localeVersion = useLocaleVersion();
  const isDark = useColorScheme() === 'dark';
  const [fontsLoaded] = useAppFonts();
  const hydrated = useListsStore((s) => s.hydrated);
  const hydrate = useListsStore((s) => s.hydrate);
  const accountHydrated = useAccountStore((s) => s.hydrated);
  const hydrateAccount = useAccountStore((s) => s.hydrate);
  const kitsHydrated = useKitsStore((s) => s.hydrated);
  const hydrateKits = useKitsStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
    hydrateAccount();
    hydrateKits();
  }, [hydrate, hydrateAccount, hydrateKits]);

  // Sync engine: start once the local store is ready, stop on teardown.
  useEffect(() => {
    if (!hydrated) return;
    startSyncEngine();
    return () => stopSyncEngine();
  }, [hydrated]);

  // On the way to the background, durably flush local state and push the latest
  // copy to peers immediately. Without this, a check made just before switching
  // apps can be lost (fire-and-forget save not yet landed) or never published
  // (the 700ms publish debounce is suspended mid-wait). Fires on 'inactive'
  // (the transition) so it runs before iOS suspends the app.
  useEffect(() => {
    if (!hydrated) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'inactive' || next === 'background') {
        flushSyncEngine();
        useListsStore.getState().flushPending();
        useKitsStore.getState().flushPending();
      }
    });
    return () => sub.remove();
  }, [hydrated]);

  // Pairing via a tapped share link: join the shared list, open it.
  useEffect(() => {
    const handle = (url: string | null) => {
      const secret = url ? parseShareLink(url) : null;
      if (!secret) return;
      const id = useListsStore.getState().joinShared(secret);
      const go = () => {
        if (navigationRef.isReady()) {
          navigationRef.navigate('ListDetail', { listId: id });
          return true;
        }
        return false;
      };
      if (!go()) setTimeout(go, 500);
    };
    Linking.getInitialURL()
      .then(handle)
      .catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  // Content is ready once fonts AND both stores have hydrated. The animated
  // splash overlays until its intro has played and content is ready, then
  // crossfades out.
  const ready = fontsLoaded && hydrated && accountHydrated && kitsHydrated;
  const [splashDone, setSplashDone] = useState(false);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <SafeAreaProvider>
      {ready && (
        <NavigationContainer key={localeVersion} ref={navigationRef} theme={buildNavTheme(isDark)}>
          <StatusBar style={isDark ? 'light' : 'dark'} />
          <Stack.Navigator
            initialRouteName="Tabs"
            screenOptions={{ headerShown: false, animation: QA_MODE ? 'none' : undefined }}
          >
            <Stack.Screen name="Tabs" component={MainTabs} />
            <Stack.Screen name="ListDetail" component={ListDetailScreen} />
            <Stack.Screen name="KitDetail" component={KitDetailScreen} />
            <Stack.Screen
              name="ReorderAisles"
              component={ReorderAislesScreen}
              options={{ presentation: 'modal' }}
            />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen
              name="Share"
              component={ShareScreen}
              options={{ presentation: 'modal' }}
            />
            <Stack.Screen name="Acknowledgements">
              {(props) => <Credits onBack={() => props.navigation.goBack()} />}
            </Stack.Screen>
          </Stack.Navigator>
        </NavigationContainer>
      )}
      {!QA_MODE && !splashDone && (
        <AnimatedSplash ready={ready} onFinish={() => setSplashDone(true)} />
      )}
    </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
