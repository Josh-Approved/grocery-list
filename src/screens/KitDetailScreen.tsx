/**
 * Kit detail — build and edit one kit.
 *
 * A kit is the short shopping shortlist for something you make — only the things
 * you actually need to buy, not the staples you always have. Add ingredients,
 * set a quantity each, rename or remove them. There's no "shop" here: a kit is a
 * template you select while adding to a list (the Add-items sheet's Kits tab).
 *
 * Sibling of ListDetailScreen, deliberately simpler: no aisles, no check-off, no
 * finish-shop. Ingredients carry a remembered quantity + an auto-assigned aisle
 * (invisible here) so they land sorted when the kit is added to a list.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronLeft, MoreHorizontal, Plus, Pencil } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useKitsStore } from '../store/kits';
import { MAX_QTY } from '../data/list';
import { visibleKitItems, kitItemCount, type KitItem } from '../data/kit';
import { Snackbar } from '../components/Snackbar';
import { SwipeRow } from '../components/SwipeRow';
import { Stepper } from '../components/Stepper';
import { useActionMenu, usePrompt } from '../components/Dialogs';
import AddIngredientsSheet from '../components/AddIngredientsSheet';
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
import { boundedContent } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'KitDetail'>;

export default function KitDetailScreen({ route, navigation }: Props) {
  const { kitId } = route.params;
  const { c } = useTheme();
  const s = makeStyles(c);

  const kit = useKitsStore((st) => st.kits.find((k) => k.id === kitId));
  const renameKit = useKitsStore((st) => st.renameKit);
  const duplicateKit = useKitsStore((st) => st.duplicateKit);
  const deleteKit = useKitsStore((st) => st.deleteKit);
  const setKitItemQuantity = useKitsStore((st) => st.setKitItemQuantity);
  const setKitItemName = useKitsStore((st) => st.setKitItemName);
  const deleteKitItem = useKitsStore((st) => st.deleteKitItem);
  const restoreKitItems = useKitsStore((st) => st.restoreKitItems);

  const menu = useActionMenu();
  const prompt = usePrompt();
  const [addOpen, setAddOpen] = useState(false);
  const [snack, setSnack] = useState<{ message: string; undo: () => void } | null>(
    null
  );

  // The kit can vanish (deleted here or via a synced delete). Leave.
  useEffect(() => {
    if (!kit) navigation.goBack();
  }, [kit, navigation]);

  const items = kit ? visibleKitItems(kit) : [];
  const count = kit ? kitItemCount(kit) : 0;

  const removeWithUndo = useCallback(
    (item: KitItem) => {
      const snap = { ...item };
      deleteKitItem(kitId, item.id);
      setSnack({
        message: t('detail.removed', { name: item.name }),
        undo: () => restoreKitItems(kitId, [snap]),
      });
    },
    [deleteKitItem, restoreKitItems, kitId]
  );

  const editItem = useCallback(
    (item: KitItem) => {
      menu.open({
        title: item.name,
        options: [
          {
            label: t('common.rename'),
            onPress: () =>
              prompt.open({
                title: t('detail.editItem'),
                initialValue: item.name,
                selectAll: true,
                confirmLabel: t('common.save'),
                onSubmit: (name) => setKitItemName(kitId, item.id, name),
              }),
          },
          {
            label: t('common.delete'),
            destructive: true,
            onPress: () => removeWithUndo(item),
          },
        ],
      });
    },
    [menu, prompt, setKitItemName, removeWithUndo, kitId]
  );

  const openKitMenu = useCallback(() => {
    if (!kit) return;
    menu.open({
      title: kit.name,
      options: [
        {
          label: t('kits.renameKit'),
          onPress: () =>
            prompt.open({
              title: t('kits.renameKit'),
              initialValue: kit.name,
              selectAll: true,
              confirmLabel: t('common.save'),
              onSubmit: (name) => renameKit(kitId, name),
            }),
        },
        {
          label: t('kits.duplicate'),
          onPress: () => {
            const id = duplicateKit(kitId);
            if (id) navigation.replace('KitDetail', { kitId: id });
          },
        },
        {
          label: t('kits.deleteKit'),
          destructive: true,
          onPress: () => {
            deleteKit(kitId);
            navigation.goBack();
          },
        },
      ],
    });
  }, [menu, prompt, kit, renameKit, duplicateKit, deleteKit, navigation, kitId]);

  const renderItem = useCallback(
    ({ item }: { item: KitItem }) => (
      <SwipeRow
        onDelete={() => removeWithUndo(item)}
        actionLabel={t('common.delete')}
        accessibilityLabel={t('detail.swipeToDeleteA11y', { name: item.name })}
      >
        <View style={s.itemRow}>
          <Pressable
            style={s.itemTap}
            onPress={() =>
              prompt.open({
                title: t('detail.editItem'),
                initialValue: item.name,
                selectAll: true,
                confirmLabel: t('common.save'),
                onSubmit: (name) => setKitItemName(kitId, item.id, name),
              })
            }
            accessibilityRole="button"
            accessibilityLabel={
              item.quantity > 1
                ? t('detail.itemWithQtyA11y', {
                    name: item.name,
                    count: item.quantity,
                  })
                : t('detail.editItemA11y', { name: item.name })
            }
          >
            <Text style={s.itemName} numberOfLines={1}>
              {item.name}
            </Text>
          </Pressable>

          <Stepper
            value={item.quantity}
            onChange={(next) => setKitItemQuantity(kitId, item.id, next)}
            min={1}
            max={MAX_QTY}
            label={t('detail.quantityOf', { name: item.name })}
          />

          <Pressable
            onPress={() => editItem(item)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('detail.editItemA11y', { name: item.name })}
            style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
          >
            <Pencil size={18} color={c.fgMuted} strokeWidth={1.5} />
          </Pressable>
        </View>
      </SwipeRow>
    ),
    [s, c, removeWithUndo, editItem, setKitItemName, setKitItemQuantity, prompt, kitId]
  );

  if (!kit) return null;

  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={s.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
        >
          <ChevronLeft size={24} color={c.fg} strokeWidth={1.5} />
        </Pressable>
        <Pressable
          style={s.headerTitleWrap}
          onPress={() =>
            prompt.open({
              title: t('kits.renameKit'),
              initialValue: kit.name,
              selectAll: true,
              confirmLabel: t('common.save'),
              onSubmit: (name) => renameKit(kitId, name),
            })
          }
          accessibilityRole="button"
          accessibilityLabel={t('kits.renameA11y', { name: kit.name })}
        >
          <Text style={s.headerTitle} numberOfLines={1}>
            {kit.name}
          </Text>
          <Text style={s.headerMeta}>
            {count === 0
              ? t('common.empty')
              : t(count === 1 ? 'kits.itemsOne' : 'kits.itemsOther', { count })}
          </Text>
        </Pressable>
        <Pressable
          onPress={openKitMenu}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('kits.kitOptions')}
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
        >
          <MoreHorizontal size={22} color={c.fg} strokeWidth={1.5} />
        </Pressable>
      </View>

      <View style={s.addBar}>
        <Pressable
          onPress={() => setAddOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t('kits.addIngredient')}
          style={({ pressed }) => [s.addTrigger, pressed && s.pressed]}
        >
          <Text style={s.addTriggerText}>{t('kits.addIngredient')}</Text>
          <Plus size={20} color={c.accent} strokeWidth={2} />
        </Pressable>
      </View>

      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={items.length === 0 ? s.emptyWrap : s.listContent}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyTitle}>{t('kits.detailEmptyTitle')}</Text>
            <Text style={s.emptyBody}>{t('kits.detailEmptyBody')}</Text>
          </View>
        }
      />

      <AddIngredientsSheet
        visible={addOpen}
        kitId={kitId}
        onClose={() => setAddOpen(false)}
      />

      <Snackbar
        visible={!!snack}
        message={snack?.message ?? ''}
        actionLabel={t('common.undo')}
        onAction={() => snack?.undo()}
        onDismiss={() => setSnack(null)}
      />

      {menu.element}
      {prompt.element}
    </SafeAreaView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    pressed: { opacity: 0.6 },

    header: {
      ...boundedContent,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.s4,
      paddingVertical: space.s3,
      gap: space.s2,
    },
    headerTitleWrap: { flex: 1, paddingHorizontal: space.s3 },
    headerTitle: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      flexShrink: 1,
    },
    headerMeta: {
      ...ty.xs,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      marginTop: space.s1,
    },
    iconBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },

    addBar: {
      ...boundedContent,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.s6,
      paddingBottom: space.s4,
    },
    addTrigger: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.bgElevated,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      borderRadius: radius.md,
      paddingHorizontal: space.s5,
      minHeight: target.min,
    },
    addTriggerText: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
    },

    listContent: {
      ...boundedContent,
      paddingHorizontal: space.s6,
      paddingBottom: space.s9,
    },
    sep: {
      height: hairline,
      backgroundColor: c.hairline,
    },
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: space.s3,
      gap: space.s3,
    },
    itemTap: {
      flex: 1,
      justifyContent: 'center',
      minHeight: target.min,
      paddingVertical: space.s1,
    },
    itemName: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fg,
    },

    emptyWrap: { ...boundedContent, flexGrow: 1, justifyContent: 'center' },
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
