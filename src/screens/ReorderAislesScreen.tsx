/**
 * Reorder aisles — drag-free, up/down controls.
 *
 * Deliberately NOT a drag-reorder library: arrow controls are fully
 * cross-platform (canon § Cross-platform functional parity — same on iOS and
 * Android), accessible (each move is a labelled button), and avoid the
 * reanimated/worklets native-pin landmine. The order is per-list so a user
 * can match their own store's layout.
 */

import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronUp, ChevronDown, X, Trash2 } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useListsStore } from '../store/lists';
import { useConfirm } from '../components/Dialogs';
import { EmptyState } from '../components/EmptyState';
import {
  categoryLabel,
  isBuiltinCategory,
  type Category,
} from '../data/categories';
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

type Props = NativeStackScreenProps<RootStackParamList, 'ReorderAisles'>;

export default function ReorderAislesScreen({ route, navigation }: Props) {
  const { listId } = route.params;
  const { c } = useTheme();
  const s = makeStyles(c);

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const reorderAisles = useListsStore((st) => st.reorderAisles);
  const removeCategory = useListsStore((st) => st.removeCategory);
  const confirm = useConfirm();
  const [order, setOrder] = useState<Category[]>(list?.categoryOrder ?? []);

  const move = useCallback(
    (index: number, dir: -1 | 1) => {
      setOrder((prev) => {
        const next = [...prev];
        const target = index + dir;
        if (target < 0 || target >= next.length) return prev;
        [next[index], next[target]] = [next[target], next[index]];
        reorderAisles(listId, next);
        return next;
      });
    },
    [listId, reorderAisles]
  );

  const remove = useCallback(
    (cat: Category) => {
      confirm.open({
        title: t('reorder.removeConfirmTitle'),
        message: t('reorder.removeConfirmBody', { name: categoryLabel(cat) }),
        confirmLabel: t('reorder.removeConfirmLabel'),
        destructive: true,
        onConfirm: () => {
          removeCategory(listId, cat);
          setOrder((prev) => prev.filter((c) => c !== cat));
        },
      });
    },
    [listId, removeCategory, confirm]
  );

  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={s.header}>
        <Text style={s.title}>{t('reorder.title')}</Text>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.done')}
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
        >
          <X size={22} color={c.fg} strokeWidth={1.5} />
        </Pressable>
      </View>
      <Text style={s.hint}>{t('reorder.hint')}</Text>
      <FlatList
        data={order}
        keyExtractor={(cat) => cat}
        contentContainerStyle={s.listContent}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        ListEmptyComponent={<EmptyState message={t('reorder.empty')} />}
        renderItem={({ item, index }) => (
          <View style={s.row}>
            <Text style={s.rowText}>{categoryLabel(item)}</Text>
            <Pressable
              onPress={() => move(index, -1)}
              disabled={index === 0}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('reorder.moveUp', {
                name: categoryLabel(item),
              })}
              style={({ pressed }) => [
                s.moveBtn,
                index === 0 && s.moveDisabled,
                pressed && s.pressed,
              ]}
            >
              <ChevronUp
                size={20}
                color={index === 0 ? c.fgSubtle : c.fg}
                strokeWidth={1.5}
              />
            </Pressable>
            <Pressable
              onPress={() => move(index, 1)}
              disabled={index === order.length - 1}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('reorder.moveDown', {
                name: categoryLabel(item),
              })}
              style={({ pressed }) => [
                s.moveBtn,
                index === order.length - 1 && s.moveDisabled,
                pressed && s.pressed,
              ]}
            >
              <ChevronDown
                size={20}
                color={index === order.length - 1 ? c.fgSubtle : c.fg}
                strokeWidth={1.5}
              />
            </Pressable>
            {!isBuiltinCategory(item) ? (
              <Pressable
                onPress={() => remove(item)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('reorder.remove', {
                  name: categoryLabel(item),
                })}
                style={({ pressed }) => [s.moveBtn, pressed && s.pressed]}
              >
                <Trash2 size={18} color={c.danger} strokeWidth={1.5} />
              </Pressable>
            ) : null}
          </View>
        )}
      />
      {confirm.element}
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
      justifyContent: 'space-between',
      paddingHorizontal: space.s5,
      paddingVertical: space.s4,
    },
    title: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },
    iconBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    hint: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      paddingHorizontal: space.s6,
      paddingBottom: space.s4,
    },
    listContent: { ...boundedContent, paddingHorizontal: space.s6, paddingBottom: space.s8 },
    sep: { height: space.s3 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.bgElevated,
      borderWidth: hairline,
      borderColor: c.hairline,
      borderRadius: radius.md,
      paddingLeft: space.s5,
      paddingRight: space.s3,
      minHeight: target.min + 8,
      gap: space.s3,
    },
    rowText: {
      ...ty.base,
      flex: 1,
      fontFamily: fontFamily.sans,
      color: c.fg,
    },
    moveBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    moveDisabled: { opacity: 0.5 },
  });
}
