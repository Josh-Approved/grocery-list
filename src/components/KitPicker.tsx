/**
 * KitPicker — the "Kits" tab inside the list Add-items sheet.
 *
 * Lists every kit you've built; tapping one drops all its ingredients onto the
 * current list in a single tap, with their remembered quantities + aisles. Items
 * already on the list are skipped (no doubling up), and the add is undoable. You
 * don't build kits here — that's the Kits tab — you select them.
 *
 * Cross-platform: pure RN, design-system tokens. Lives inside a parent that
 * provides the SafeAreaProvider.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Plus } from 'lucide-react-native';
import { Snackbar } from './Snackbar';
import { useListsStore } from '../store/lists';
import { useKitsStore } from '../store/kits';
import { visibleItems } from '../data/list';
import { kitItemCount, visibleKitItems, visibleKits, type Kit } from '../data/kit';
import { t } from '../i18n';
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
  listId: string;
}

const PREVIEW_NAMES = 3;

export default function KitPicker({ listId }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const addKitItems = useListsStore((st) => st.addKitItems);
  const removeItems = useListsStore((st) => st.removeItems);
  const kits = useKitsStore((st) => st.kits);

  const [snack, setSnack] = useState<{
    message: string;
    undo?: () => void;
  } | null>(null);

  const data = useMemo(
    () => visibleKits(kits).sort((a, b) => b.updatedAt - a.updatedAt),
    [kits]
  );

  const activeNames = useMemo(
    () =>
      new Set((list ? visibleItems(list) : []).map((it) => it.name.toLowerCase())),
    [list]
  );

  const addKit = useCallback(
    (kit: Kit) => {
      const items = visibleKitItems(kit);
      if (items.length === 0) {
        setSnack({ message: t('kits.kitEmpty') });
        return;
      }
      const added = addKitItems(
        listId,
        items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          category: it.category,
        }))
      );
      Haptics.selectionAsync().catch(() => {});
      if (added.length === 0) {
        setSnack({ message: t('kits.allPresent') });
        return;
      }
      const ids = added.map((it) => it.id);
      setSnack({
        message: t(added.length === 1 ? 'kits.addedOne' : 'kits.addedOther', {
          count: added.length,
        }),
        undo: () => removeItems(listId, ids),
      });
    },
    [addKitItems, removeItems, listId]
  );

  const renderItem = useCallback(
    ({ item: kit }: { item: Kit }) => {
      const items = visibleKitItems(kit);
      const count = items.length;
      const preview = items.slice(0, PREVIEW_NAMES).map((it) => it.name).join(', ');
      const extra = count - PREVIEW_NAMES;
      const previewText =
        count === 0
          ? t('common.empty')
          : extra > 0
            ? t('kits.previewMore', { names: preview, count: extra })
            : preview;
      return (
        <Pressable
          style={({ pressed }) => [s.row, pressed && s.pressed]}
          onPress={() => addKit(kit)}
          accessibilityRole="button"
          accessibilityLabel={t('kits.addKitA11y', { name: kit.name, count })}
        >
          <View style={s.rowMain}>
            <Text style={s.rowName} numberOfLines={1}>
              {kit.name}
            </Text>
            <Text style={s.rowPreview} numberOfLines={1}>
              {previewText}
            </Text>
          </View>
          <View
            style={s.addBadge}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Plus size={18} color={c.accent} strokeWidth={2} />
          </View>
        </Pressable>
      );
    },
    [s, c, addKit]
  );

  return (
    <View style={s.flex}>
      <FlatList
        data={data}
        keyExtractor={(k) => k.id}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        contentContainerStyle={data.length === 0 ? s.emptyWrap : s.listContent}
        ListHeaderComponent={
          data.length > 0 ? <Text style={s.hint}>{t('kits.pickHint')}</Text> : null
        }
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyTitle}>{t('kits.emptyTitle')}</Text>
            <Text style={s.emptyBody}>{t('kits.emptyInSheet')}</Text>
          </View>
        }
      />

      <Snackbar
        visible={!!snack}
        message={snack?.message ?? ''}
        actionLabel={snack?.undo ? t('common.undo') : undefined}
        onAction={snack?.undo}
        onDismiss={() => setSnack(null)}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    pressed: { opacity: 0.6 },

    hint: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgSubtle,
      marginBottom: space.s4,
      lineHeight: 20,
    },
    listContent: {
      paddingHorizontal: space.s6,
      paddingTop: space.s4,
      paddingBottom: space.s9,
    },
    sep: { height: space.s3 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.bgElevated,
      borderWidth: hairline,
      borderColor: c.hairline,
      borderRadius: radius.lg,
      paddingVertical: space.s4,
      paddingLeft: space.s5,
      paddingRight: space.s4,
      gap: space.s3,
    },
    rowMain: { flex: 1 },
    rowName: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      flexShrink: 1,
    },
    rowPreview: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      marginTop: space.s1,
    },
    addBadge: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      backgroundColor: c.accentBg,
    },

    emptyWrap: { flexGrow: 1, justifyContent: 'center' },
    empty: { paddingHorizontal: space.s7, alignItems: 'center' },
    emptyTitle: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      marginBottom: space.s3,
    },
    emptyBody: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
    },
  });
}
