/**
 * Add ingredients — the full-screen sheet for building a kit.
 *
 * The kit sibling of AddItemsSheet's Items tab: the same reusable ItemPicker
 * (your usuals / recent / seed catalog), but each pick is added to the KIT
 * instead of a list. No Kits tab here — you can't put a kit inside a kit.
 *
 * Cross-platform: pure RN `Modal`; nests its own SafeAreaProvider (canon
 * § rn/modal-safe-area-provider).
 */

import React, { useCallback, useMemo } from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import { useReducedMotion } from './Dialogs';
import ItemPicker from './ItemPicker';
import { useKitsStore } from '../store/kits';
import { visibleKitItems } from '../data/kit';
import { t, pickLocale, getLocale, CANONICAL_LOCALES } from '../i18n';
import { useLocalePreference } from '../i18n/localePreference';
import {
  useTheme,
  fontFamily,
  space,
  target,
  type as ty,
  type Colors,
} from '../theme';

interface Props {
  visible: boolean;
  kitId: string;
  onClose: () => void;
}

export default function AddIngredientsSheet({ visible, kitId, onClose }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();

  const kit = useKitsStore((st) => st.kits.find((k) => k.id === kitId));
  const addKitItem = useKitsStore((st) => st.addKitItem);

  const { pref } = useLocalePreference();
  const activeLocale =
    pref === 'system'
      ? pickLocale(getLocale(), [...CANONICAL_LOCALES]) ?? 'en'
      : pref;

  const activeNames = useMemo(
    () =>
      new Set((kit ? visibleKitItems(kit) : []).map((it) => it.name.toLowerCase())),
    [kit]
  );

  const onAdd = useCallback(
    (name: string, category?: Parameters<typeof addKitItem>[3]) => {
      addKitItem(kitId, name, activeLocale, category);
    },
    [addKitItem, kitId, activeLocale]
  );

  return (
    <Modal
      visible={visible}
      animationType={reduced ? 'none' : 'slide'}
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <SafeAreaView style={s.safe} edges={['top', 'bottom', 'left', 'right']}>
          <View style={s.topBar}>
            <Text style={s.title} accessibilityRole="header">
              {t('kits.addIngredientsTitle')}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.done')}
              style={({ pressed }) => [s.doneBtn, pressed && s.pressed]}
            >
              <Text style={s.doneText}>{t('common.done')}</Text>
            </Pressable>
          </View>

          <ItemPicker
            activeNames={activeNames}
            onAdd={onAdd}
            targetName={kit?.name ?? ''}
            onClose={onClose}
            presentLabel={t('kits.inKit')}
            presentA11y={(name) => t('kits.inKitItemA11y', { name })}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    pressed: { opacity: 0.6 },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.s6,
      paddingTop: space.s3,
      paddingBottom: space.s3,
    },
    title: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },
    doneBtn: {
      minHeight: target.min,
      justifyContent: 'center',
      paddingLeft: space.s4,
    },
    doneText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.accent,
    },
  });
}
