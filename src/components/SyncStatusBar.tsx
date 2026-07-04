/**
 * A small, honest live-sync indicator for a shared list — and a tap-to-resync.
 *
 * Shared lists are best-effort over public relays; this makes the connection
 * state visible instead of silent ("honest about live-ness" tenet) so a stale
 * list is noticeable, and gives the user a one-tap "sync now" (push our state +
 * pull peers') if they suspect they're out of date. Nothing here leaves the
 * device. First rung of the user-volunteered diagnostics direction.
 */
import React, { useCallback, useRef, useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { RefreshCw } from 'lucide-react-native';
import { useChannelStatus } from '../sync/status';
import { resyncNow } from '../sync';
import { t } from '../i18n';
import {
  useTheme,
  fontFamily,
  space,
  target,
  type as ty,
  type Colors,
} from '../theme';

export function SyncStatusBar({ secret }: { secret: string }) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const status = useChannelStatus(secret);
  const [syncing, setSyncing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onPress = useCallback(() => {
    resyncNow(secret);
    setSyncing(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSyncing(false), 1500);
  }, [secret]);

  const label = syncing
    ? t('detail.sync.syncing')
    : status.connected
      ? status.publishRejected
        ? t('detail.sync.trouble')
        : t('detail.sync.connected')
      : t('detail.sync.offline');
  // Accent (not approval-green — that token is reserved for the verified/done
  // semantic) marks an active connection; muted marks offline OR a connection
  // that relays are refusing our updates on ("connected" would be dishonest —
  // the socket is up but nothing we publish is being carried). The text label
  // carries the meaning, so the dot is a secondary indicator, never colour-only.
  const dotColor =
    syncing || (status.connected && !status.publishRejected)
      ? c.appAccent
      : c.fgSubtle;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('detail.sync.a11y', { status: label })}
      style={({ pressed }) => [s.row, pressed && s.pressed]}
    >
      <View
        style={[s.dot, { backgroundColor: dotColor }]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text style={s.label}>{label}</Text>
      <RefreshCw size={16} color={c.fgSubtle} strokeWidth={1.5} />
    </Pressable>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
      minHeight: target.min,
      paddingHorizontal: space.s6,
      paddingBottom: space.s3,
    },
    pressed: { opacity: 0.6 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    label: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted },
  });
}
