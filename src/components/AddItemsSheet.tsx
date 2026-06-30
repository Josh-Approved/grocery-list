/**
 * Add items — the full-screen sheet that is the hub for building a list fast.
 *
 * Opens from the List-detail "Add an item" bar. Two tabs:
 *   - Items — your usuals, recent history, and the built-in seed catalog, one
 *     tap each (the reusable ItemPicker).
 *   - Kits — your saved kits; one tap drops a whole kit's ingredients onto the
 *     list (KitPicker). You build kits on the Kits tab, not here.
 *
 * This component is just the shell: the Modal, the safe-area, the top bar, and
 * the Items/Kits segmented control. The two tabs are self-contained.
 *
 * Cross-platform: pure RN `Modal` + design-system tokens — no ActionSheetIOS /
 * Alert.prompt (canon § Cross-platform functional parity). A RN Modal renders
 * detached from the root SafeAreaProvider, so we nest one (canon
 * § rn/modal-safe-area-provider).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import { useReducedMotion } from './Dialogs';
import ItemPicker from './ItemPicker';
import KitPicker from './KitPicker';
import { useListsStore } from '../store/lists';
import { visibleItems } from '../data/list';
import { t, pickLocale, getLocale, CANONICAL_LOCALES } from '../i18n';
import { useLocalePreference } from '../i18n/localePreference';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  target,
  type as ty,
  hairline,
  type Colors,
} from '../theme';

interface Props {
  visible: boolean;
  listId: string;
  onClose: () => void;
}

type Tab = 'items' | 'kits';

export default function AddItemsSheet({ visible, listId, onClose }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();
  const [tab, setTab] = useState<Tab>('items');

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const addItem = useListsStore((st) => st.addItem);

  const { pref } = useLocalePreference();
  const activeLocale =
    pref === 'system'
      ? pickLocale(getLocale(), [...CANONICAL_LOCALES]) ?? 'en'
      : pref;

  // Always open on the Items tab.
  useEffect(() => {
    if (visible) setTab('items');
  }, [visible]);

  const activeNames = useMemo(
    () =>
      new Set((list ? visibleItems(list) : []).map((it) => it.name.toLowerCase())),
    [list]
  );

  const onAdd = useCallback(
    (name: string, category?: Parameters<typeof addItem>[3]) => {
      addItem(listId, name, activeLocale, category);
    },
    [addItem, listId, activeLocale]
  );

  const renderTab = (which: Tab, label: string) => {
    const active = tab === which;
    return (
      <Pressable
        onPress={() => setTab(which)}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        style={[s.segment, active && s.segmentActive]}
      >
        <Text style={[s.segmentText, active && s.segmentTextActive]}>{label}</Text>
      </Pressable>
    );
  };

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
              {t('detail.addItemsTitle')}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              testID="addSheetDone"
              accessibilityRole="button"
              accessibilityLabel={t('common.done')}
              style={({ pressed }) => [s.doneBtn, pressed && s.pressed]}
            >
              <Text style={s.doneText}>{t('common.done')}</Text>
            </Pressable>
          </View>

          <View style={s.segments} accessibilityRole="tablist">
            {renderTab('items', t('detail.tabItems'))}
            {renderTab('kits', t('detail.tabKits'))}
          </View>

          {tab === 'items' ? (
            <ItemPicker
              activeNames={activeNames}
              onAdd={onAdd}
              targetName={list?.name ?? ''}
              onClose={onClose}
              presentLabel={t('detail.onList')}
              presentA11y={(name) => t('detail.onListItemA11y', { name })}
            />
          ) : (
            <KitPicker listId={listId} />
          )}
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

    segments: {
      flexDirection: 'row',
      gap: space.s1,
      marginHorizontal: space.s6,
      marginBottom: space.s3,
      padding: space.s1,
      backgroundColor: c.bgSubtle,
      borderWidth: hairline,
      borderColor: c.hairline,
      borderRadius: radius.md,
    },
    segment: {
      flex: 1,
      minHeight: target.min - space.s2,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      paddingVertical: space.s2,
    },
    segmentActive: {
      backgroundColor: c.bgElevated,
      borderWidth: hairline,
      borderColor: c.hairline,
    },
    segmentText: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
    },
    segmentTextActive: {
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },
  });
}
