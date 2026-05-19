import { useFonts } from 'expo-font';

/**
 * Loads all Josh Approved typefaces. Call once at the app root and gate render
 * on the returned `loaded` flag (or render a splash until it's true).
 *
 *   const [loaded] = useAppFonts();
 *   if (!loaded) return null; // SplashScreen stays visible
 */
export function useAppFonts() {
  return useFonts({
    'IBMPlexSans-Regular': require('../../assets/fonts/IBMPlexSans-Regular.otf'),
    'IBMPlexSans-Medium': require('../../assets/fonts/IBMPlexSans-Medium.otf'),
    'IBMPlexSans-SemiBold': require('../../assets/fonts/IBMPlexSans-SemiBold.otf'),
    'IBMPlexMono-Regular': require('../../assets/fonts/IBMPlexMono-Regular.otf'),
    'IBMPlexMono-Medium': require('../../assets/fonts/IBMPlexMono-Medium.otf'),
  });
}
