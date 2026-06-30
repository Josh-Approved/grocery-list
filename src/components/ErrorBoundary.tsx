/**
 * Top-level error boundary — catches render-time crashes anywhere in the tree
 * and shows a calm, design-system fallback instead of a white screen or the
 * red box. Wrapped around the app by AppShell. Canonical, app-agnostic —
 * synced by `sync.mjs app-shell`; do not fork.
 *
 * A class component is required (React only supports error boundaries as
 * classes); the visible fallback is a function component so it can use theme
 * tokens. No telemetry is sent (canon § Analytics & telemetry) — the error is
 * logged to the console only, scrubbed of nothing because nothing leaves.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, fontFamily, space, type as ty, type Colors } from '../theme';
import { t } from '../i18n';

function Fallback() {
  const { c } = useTheme();
  const s = makeStyles(c);
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.center}>
        <Text style={s.title}>{t('error.title')}</Text>
        <Text style={s.body}>{t('error.body')}</Text>
      </View>
    </SafeAreaView>
  );
}

type Props = { children: React.ReactNode };
type State = { hasError: boolean };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    // Console only — no reporter, no PII off-device (canon § Analytics).
    console.warn('Caught render error:', error);
  }

  render() {
    if (this.state.hasError) return <Fallback />;
    return this.props.children;
  }
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.s7,
      gap: space.s4,
    },
    title: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      textAlign: 'center',
    },
    body: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
    },
  });
}
