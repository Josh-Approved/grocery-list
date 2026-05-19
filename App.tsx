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

import React, { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  type Theme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAppFonts, lightColors, darkColors, typography } from './src/theme';
import { useListsStore } from './src/store/lists';
import ListsHomeScreen from './src/screens/ListsHomeScreen';
import ListDetailScreen from './src/screens/ListDetailScreen';

export type RootStackParamList = {
  ListsHome: undefined;
  ListDetail: { listId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

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
  const isDark = useColorScheme() === 'dark';
  const [fontsLoaded] = useAppFonts();
  const hydrated = useListsStore((s) => s.hydrated);
  const hydrate = useListsStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (!fontsLoaded || !hydrated) return null;

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={buildNavTheme(isDark)}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Stack.Navigator
          initialRouteName="ListsHome"
          screenOptions={{ headerShown: false }}
        >
          <Stack.Screen name="ListsHome" component={ListsHomeScreen} />
          <Stack.Screen name="ListDetail" component={ListDetailScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
