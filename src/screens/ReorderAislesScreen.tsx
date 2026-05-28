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
import { ChevronUp, ChevronDown, X } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useListsStore } from '../store/lists';
import type { Category } from '../data/categories';
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
import { boundedContent } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ReorderAisles'>;

export default function ReorderAislesScreen({ route, navigation }: Props) {
  const { listId } = route.params;
  const { c } = useTheme();
  const s = makeStyles(c);

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const reorderAisles = useListsStore((st) => st.reorderAisles);
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

  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={s.header}>
        <Text style={s.title}>Reorder aisles</Text>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Done"
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
        >
          <X size={22} color={c.fg} strokeWidth={1.5} />
        </Pressable>
      </View>
      <Text style={s.hint}>
        Put these in the order you walk your store. Items sort into this
        order on the list.
      </Text>
      <FlatList
        data={order}
        keyExtractor={(cat) => cat}
        contentContainerStyle={s.listContent}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        renderItem={({ item, index }) => (
          <View style={s.row}>
            <Text style={s.rowText}>{item}</Text>
            <Pressable
              onPress={() => move(index, -1)}
              disabled={index === 0}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Move ${item} up`}
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
              accessibilityLabel={`Move ${item} down`}
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
          </View>
        )}
      />
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
    hint: {
      ...t.sm,
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
      ...t.base,
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
