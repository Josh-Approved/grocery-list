/**
 * Share a list — the entire pairing UX.
 *
 * Person 1: a QR + a link, sent however they like. Person 2: scan it or tap
 * it. No account, no sign-up, ever. After this one handshake the two devices
 * stay synced forever (the link is just the introduction).
 */

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Share,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { X, Share2, ScanLine } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useListsStore } from '../store/lists';
import { buildShareLink, parseShareLink } from '../sync/share';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  target,
  type as t,
  hairline,
  type Colors,
} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Share'>;

export default function ShareScreen({ route, navigation }: Props) {
  const { listId } = route.params;
  const { c } = useTheme();
  const s = makeStyles(c);

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const shareList = useListsStore((st) => st.shareList);
  const joinShared = useListsStore((st) => st.joinShared);

  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const secret = list ? shareList(listId) : null;
  const link = secret ? buildShareLink(secret) : '';

  const onSend = useCallback(() => {
    if (link) Share.share({ message: link }).catch(() => {});
  }, [link]);

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      const sec = parseShareLink(data);
      if (!sec) return;
      setScanning(false);
      const id = joinShared(sec);
      navigation.replace('ListDetail', { listId: id });
    },
    [joinShared, navigation]
  );

  const startScan = useCallback(async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return;
    }
    setScanning(true);
  }, [permission, requestPermission]);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={s.header}>
        <Text style={s.title}>
          {scanning ? 'Scan a list code' : 'Share this list'}
        </Text>
        <Pressable
          onPress={() =>
            scanning ? setScanning(false) : navigation.goBack()
          }
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
        >
          <X size={22} color={c.fg} strokeWidth={1.5} />
        </Pressable>
      </View>

      {scanning ? (
        <View style={s.scanWrap}>
          <CameraView
            style={s.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
          <Text style={s.hint}>
            Point at the other phone's QR code.
          </Text>
        </View>
      ) : (
        <View style={s.body}>
          <Text style={s.lead}>
            Anyone with this can see and edit{' '}
            <Text style={s.leadStrong}>{list?.name ?? 'this list'}</Text>.
            No account needed. You only do this once.
          </Text>
          {link ? (
            <View style={s.qrCard}>
              <QRCode value={link} size={216} backgroundColor="#FFFFFF" />
            </View>
          ) : null}
          <Pressable
            onPress={onSend}
            accessibilityRole="button"
            accessibilityLabel="Send link"
            style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
          >
            <Share2 size={18} color={c.inkButtonText} strokeWidth={1.5} />
            <Text style={s.primaryText}>Send link</Text>
          </Pressable>
          <Pressable
            onPress={startScan}
            accessibilityRole="button"
            accessibilityLabel="Scan a list code instead"
            style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]}
          >
            <ScanLine size={18} color={c.fg} strokeWidth={1.5} />
            <Text style={s.ghostText}>Scan a code instead</Text>
          </Pressable>
        </View>
      )}
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
      paddingHorizontal: space.s5,
      paddingVertical: space.s4,
    },
    title: { ...t.md, fontFamily: fontFamily.sansSemibold, color: c.fg },
    iconBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    body: { flex: 1, alignItems: 'center', paddingHorizontal: space.s7, gap: space.s6 },
    lead: {
      ...t.base,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
      marginTop: space.s4,
    },
    leadStrong: { fontFamily: fontFamily.sansSemibold, color: c.fg },
    qrCard: {
      padding: space.s6,
      backgroundColor: '#FFFFFF',
      borderRadius: radius.lg,
      borderWidth: hairline,
      borderColor: c.hairline,
    },
    primaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.s3,
      minHeight: target.min,
      paddingHorizontal: space.s7,
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
      alignSelf: 'stretch',
    },
    primaryText: {
      ...t.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
    ghostBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.s3,
      minHeight: target.min,
    },
    ghostText: { ...t.base, fontFamily: fontFamily.sans, color: c.fg },
    scanWrap: { flex: 1, alignItems: 'center', gap: space.s5 },
    camera: {
      width: '86%',
      aspectRatio: 1,
      borderRadius: radius.lg,
      overflow: 'hidden',
      marginTop: space.s5,
    },
    hint: {
      ...t.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
    },
  });
}
