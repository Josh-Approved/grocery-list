/**
 * Settings / About — the one known-shape destination (canon § Settings /
 * About). App-specific settings sit above the About block; the canonical
 * entries (BMAC, feedback, review, privacy, source, version, the stamp) are
 * the floor, not the ceiling.
 */

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  HandHeart,
  Mail,
  Star,
  Shield,
  Code2,
  Upload,
  Download,
} from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useListsStore } from '../store/lists';
import { exportLists, pickAndParseLists } from '../lib/transfer';
import { AboutRow } from '../components/AboutRow';
import { Wordmark } from '../components/Wordmark';
import {
  APP_NAME,
  BMAC_URL,
  PRIVACY_URL,
  REPO_URL,
  STUDIO_URL,
  openFeedbackMail,
  openReview,
  openUrl,
  versionLabel,
} from '../lib/links';
import {
  useTheme,
  fontFamily,
  space,
  target,
  type as t,
  type Colors,
} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const lists = useListsStore((st) => st.lists);
  const importLists = useListsStore((st) => st.importLists);
  const [status, setStatus] = useState<string | null>(null);

  const onExport = useCallback(() => {
    exportLists(lists).catch(() => setStatus("Couldn't export."));
  }, [lists]);

  const onImport = useCallback(async () => {
    try {
      const incoming = await pickAndParseLists();
      if (incoming.length === 0) {
        setStatus('Nothing imported.');
        return;
      }
      const n = importLists(incoming);
      setStatus(`Added ${n} list${n === 1 ? '' : 's'}.`);
    } catch {
      setStatus("Couldn't read that file.");
    }
  }, [importLists]);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={s.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
        >
          <ChevronLeft size={24} color={c.fg} strokeWidth={1.5} />
        </Pressable>
        <Text style={s.title}>Settings</Text>
        <View style={s.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.sectionLabel}>Your data</Text>
        <AboutRow label="Export lists" icon={Upload} onPress={onExport} />
        <AboutRow label="Import lists" icon={Download} onPress={onImport} />
        {status ? <Text style={s.status}>{status}</Text> : null}

        <Text style={s.sectionLabel}>About</Text>
        <AboutRow label="Support this app" icon={HandHeart} onPress={() => openUrl(BMAC_URL)} />
        <AboutRow label="Send feedback" icon={Mail} onPress={openFeedbackMail} />
        <AboutRow label="Leave a review" icon={Star} onPress={openReview} />
        <AboutRow label="Privacy" icon={Shield} onPress={() => openUrl(PRIVACY_URL)} />
        <AboutRow label="Source code" icon={Code2} onPress={() => openUrl(REPO_URL)} />
        <AboutRow label="Version" value={versionLabel()} />

        <View style={s.stamp}>
          <Wordmark />
          <Text style={s.stampLine}>
            Privacy-first replacements for paywalled utility apps. Open
            source. Pay what you want.
          </Text>
          <Pressable
            onPress={() => openUrl(STUDIO_URL)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Learn more at joshapproved.com"
          >
            <Text style={s.learnMore}>Learn more</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    pressed: { opacity: 0.6 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.s4,
      paddingVertical: space.s3,
    },
    title: {
      ...t.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },
    iconBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: { paddingBottom: space.s9 },
    sectionLabel: {
      ...t.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      paddingHorizontal: space.s6,
      paddingTop: space.s7,
      paddingBottom: space.s3,
    },
    status: {
      ...t.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      paddingHorizontal: space.s6,
      paddingTop: space.s4,
    },
    stamp: {
      alignItems: 'center',
      paddingHorizontal: space.s7,
      paddingTop: space.s9,
      gap: space.s3,
    },
    stampLine: {
      ...t.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
    },
    learnMore: {
      ...t.sm,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      paddingVertical: space.s2,
    },
  });
}
