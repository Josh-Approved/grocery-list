/**
 * A small, honest live-sync indicator for a shared list — and a tap-to-resync.
 *
 * Two facts, kept apart on purpose: whether the DROP BOXES are reachable
 * ("Connected" / "Offline" / "Not syncing") and when the OTHER PHONE was last
 * heard from ("Other phone seen 3 h ago" / "Nothing from the other phone
 * yet"). Before store-and-forward the first was shown alone, and it read as
 * "the partner is here" when it only ever meant "the relays answered" — the
 * exact confusion behind "both phones say Connected but nothing arrives".
 * Tap = one-shot "sync now" (push our state + pull peers'). Nothing here
 * leaves the device.
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

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "just now" / "3 min ago" / "3 h ago" / "2 days ago" — coarse on purpose. */
export function relativeAgo(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return t('detail.sync.justNow');
  if (d < HOUR) return t('detail.sync.minutesAgo', { n: Math.floor(d / MIN) });
  if (d < DAY) return t('detail.sync.hoursAgo', { n: Math.floor(d / HOUR) });
  const days = Math.floor(d / DAY);
  return days === 1 ? t('detail.sync.dayAgo') : t('detail.sync.daysAgo', { n: days });
}

export function SyncStatusBar({ secret }: { secret: string }) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const status = useChannelStatus(secret);
  const [syncing, setSyncing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "3 min ago" has to keep moving while the list sits on screen: a once-a-
  // minute tick re-renders; the label itself always reads the clock fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const tick = setInterval(() => setTick((n) => n + 1), MIN);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onPress = useCallback(() => {
    resyncNow(secret);
    setSyncing(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSyncing(false), 1500);
  }, [secret]);

  const reach = syncing
    ? t('detail.sync.syncing')
    : status.connected
      ? status.publishRejected
        ? t('detail.sync.trouble')
        : t('detail.sync.connected')
      : t('detail.sync.offline');
  const partner =
    status.lastReceivedAt == null
      ? t('detail.sync.partnerNever')
      : t('detail.sync.partnerSeen', {
          when: relativeAgo(status.lastReceivedAt, Date.now()),
        });
  const label = syncing ? reach : `${reach} · ${partner}`;
  // Accent (not approval-green — that token is reserved for the verified/done
  // semantic) marks reachable drop boxes; muted marks offline OR a connection
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
      // The status text is what a person can see, so it is the accessible name
      // and Voice Control can match it. The "shared list sync / tap to sync"
      // framing moves to the hint, which Voice Control ignores and VoiceOver
      // still reads.
      accessibilityLabel={label}
      accessibilityHint={t('detail.sync.hint')}
      style={({ pressed }) => [s.row, pressed && s.pressed]}
    >
      <View
        style={[s.dot, { backgroundColor: dotColor }]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text style={s.label} numberOfLines={2}>
        {label}
      </Text>
      <RefreshCw size={16} color={c.fgMuted} strokeWidth={1.5} />
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
    label: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted, flexShrink: 1 },
  });
}
