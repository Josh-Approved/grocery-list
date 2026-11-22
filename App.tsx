/**
 * App root.
 *
 * Two top-level tabs (Lists | Kits) inside a stack that also holds ListDetail,
 * KitDetail, Settings, Share, and Acknowledgements. State lives in Zustand
 * stores over SQLite; the stores hydrate on mount and persist in the background.
 *
 * The shell (<AppShell/>) owns the chrome — gesture root, safe area, error
 * boundary, themed NavigationContainer, status bar, and the cold-start splash.
 * App.tsx owns the readiness gate, the screen list, and this app's startup
 * effects (hydrate, live sync, background-durability flush, share-link pairing).
 */

import React, { useEffect } from 'react';
import { useColorScheme, AppState } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ListChecks, Boxes } from 'lucide-react-native';
import {
  useAppFonts,
  lightColors,
  darkColors,
  typography,
  hairline,
} from './src/theme';
import { AppShell } from './src/shell/AppShell';
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
import { drainPendingSiriItems, startSiriListSync } from './src/siri';
import { useShareLinkIntake } from './src/sync/shareIntake';
import { t } from './src/i18n';
import { IOS_APP_STORE_ID, ANDROID_PACKAGE } from './src/lib/links';
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

/** Store identity for the canonical review prompt. The shell owns the trigger
 *  (session count, 3/15/30 schedule, 3-per-install cap) — this app carries no
 *  trigger code. Module scope so the object identity is stable across renders. */
const REVIEW = {
  appName: 'Grocery List',
  iosAppStoreId: IOS_APP_STORE_ID,
  androidPackageName: ANDROID_PACKAGE,
};

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

export default function App() {
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

  // Siri (iOS only; no-op elsewhere): once the store is ready, pull in any
  // items dictated to Siri while we were closed, and keep Siri's view of the
  // lists mirrored so "add milk to <list>" can resolve the right list.
  useEffect(() => {
    if (!hydrated) return;
    void drainPendingSiriItems();
    return startSiriListSync();
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
      // Coming back to the foreground: drain anything added via Siri while away.
      if (next === 'active') {
        void drainPendingSiriItems();
      }
    });
    return () => sub.remove();
  }, [hydrated]);

  // Content is ready once fonts AND every store has hydrated (so a populated
  // database doesn't flash an empty "no lists yet" state on launch).
  const ready = fontsLoaded && hydrated && accountHydrated && kitsHydrated;

  // Pairing via a tapped / scanned share link: join the shared list, open it.
  // The intake holds a link that launched the app until the stores have read
  // the disk; joining earlier lost the list on a cold start (customer report
  // 2026-10-24: "the QR code opens the app but doesn't give the shared list").
  useShareLinkIntake({
    ready,
    join: (secret) => useListsStore.getState().joinShared(secret),
    open: (listId) => {
      if (!navigationRef.isReady()) return false;
      navigationRef.navigate('ListDetail', { listId });
      return true;
    },
  });

  return (
    <AppShell ready={ready} navigationRef={navigationRef} review={REVIEW}>
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
    </AppShell>
  );
}
