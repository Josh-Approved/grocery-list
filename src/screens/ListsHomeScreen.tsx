/**
 * Lists home — every list the user has, newest first.
 *
 * Create a list, open one, or rename / duplicate / delete via a per-row
 * overflow menu (cross-platform `Dialogs`, never ActionSheetIOS). Sharing is
 * wired at build step 4; Settings at step 6.
 */

import React, { useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Plus, MoreHorizontal, ChevronRight, Settings } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useListsStore } from '../store/lists';
import { listStats, type GroceryList } from '../data/list';
import { useActionMenu, usePrompt } from '../components/Dialogs';
import { FundingFooter } from '../components/FundingFooter';
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

type Props = NativeStackScreenProps<RootStackParamList, 'ListsHome'>;

export default function ListsHomeScreen({ navigation }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const lists = useListsStore((st) => st.lists);
  const createList = useListsStore((st) => st.createList);
  const renameList = useListsStore((st) => st.renameList);
  const duplicateList = useListsStore((st) => st.duplicateList);
  const deleteList = useListsStore((st) => st.deleteList);

  const menu = useActionMenu();
  const prompt = usePrompt();

  const newList = useCallback(() => {
    prompt.open({
      title: 'New list',
      placeholder: 'Groceries',
      confirmLabel: 'Create',
      onSubmit: (name) => {
        const id = createList(name);
        navigation.navigate('ListDetail', { listId: id });
      },
    });
  }, [prompt, createList, navigation]);

  const openMenu = useCallback(
    (list: GroceryList) => {
      menu.open({
        title: list.name,
        options: [
          {
            label: 'Rename',
            onPress: () =>
              prompt.open({
                title: 'Rename list',
                initialValue: list.name,
                selectAll: true,
                confirmLabel: 'Save',
                onSubmit: (name) => renameList(list.id, name),
              }),
          },
          {
            label: list.shareIdentity ? 'Sharing settings' : 'Share',
            onPress: () =>
              navigation.navigate('Share', { listId: list.id }),
          },
          {
            label: 'Duplicate',
            onPress: () => duplicateList(list.id),
          },
          {
            label: 'Delete',
            destructive: true,
            onPress: () => deleteList(list.id),
          },
        ],
      });
    },
    [menu, prompt, renameList, duplicateList, deleteList, navigation]
  );

  const renderItem = useCallback(
    ({ item }: { item: GroceryList }) => {
      const { total, checked } = listStats(item);
      const pct = total === 0 ? 0 : checked / total;
      return (
        <Pressable
          style={({ pressed }) => [s.row, pressed && s.rowPressed]}
          onPress={() => navigation.navigate('ListDetail', { listId: item.id })}
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, ${checked} of ${total} checked`}
        >
          <View style={s.rowMain}>
            <Text style={s.rowName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={s.rowMeta}>
              {total === 0
                ? 'Empty'
                : `${checked} of ${total} checked`}
            </Text>
            <View style={s.track}>
              <View style={[s.fill, { width: `${Math.round(pct * 100)}%` }]} />
            </View>
          </View>
          <Pressable
            onPress={() => openMenu(item)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Options for ${item.name}`}
            style={({ pressed }) => [s.iconBtn, pressed && s.rowPressed]}
          >
            <MoreHorizontal size={20} color={c.fgMuted} strokeWidth={1.5} />
          </Pressable>
          <ChevronRight size={20} color={c.fgSubtle} strokeWidth={1.5} />
        </Pressable>
      );
    },
    [s, c, navigation, openMenu]
  );

  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={s.header}>
        <View style={s.headerText}>
          <Text style={s.title}>Grocery List</Text>
          <Text style={s.subtitle}>Shop together, off one list.</Text>
        </View>
        <Pressable
          onPress={newList}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="New list"
          style={({ pressed }) => [s.newBtn, pressed && s.rowPressed]}
        >
          <Plus size={18} color={c.fg} strokeWidth={1.5} />
          <Text style={s.newBtnText}>New list</Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('Settings')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          style={({ pressed }) => [s.iconBtn, pressed && s.rowPressed]}
        >
          <Settings size={20} color={c.fgMuted} strokeWidth={1.5} />
        </Pressable>
      </View>

      <FlatList
        style={s.flex}
        data={lists}
        keyExtractor={(l) => l.id}
        renderItem={renderItem}
        contentContainerStyle={
          lists.length === 0 ? s.emptyWrap : s.listContent
        }
        ItemSeparatorComponent={() => <View style={s.sep} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyTitle}>No lists yet</Text>
            <Text style={s.emptyBody}>
              Create a list, then share it so anyone in your household can add
              to it and check things off as you shop.
            </Text>
            <Pressable
              onPress={newList}
              accessibilityRole="button"
              accessibilityLabel="Create your first list"
              style={({ pressed }) => [s.emptyBtn, pressed && s.rowPressed]}
            >
              <Text style={s.emptyBtnText}>Create a list</Text>
            </Pressable>
          </View>
        }
      />

      <FundingFooter />

      {menu.element}
      {prompt.element}
    </SafeAreaView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    flex: { flex: 1 },
    rowPressed: { opacity: 0.6 },

    header: {
      ...boundedContent,
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      paddingHorizontal: space.s6,
      paddingTop: space.s5,
      paddingBottom: space.s5,
    },
    headerText: { flex: 1, paddingRight: space.s5 },
    title: {
      fontFamily: fontFamily.sansSemibold,
      fontSize: 28,
      lineHeight: 34,
      color: c.fg,
    },
    subtitle: {
      ...t.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      marginTop: space.s2,
    },
    newBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: target.min,
      paddingHorizontal: space.s4,
      gap: space.s2,
    },
    newBtnText: {
      ...t.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },

    listContent: { ...boundedContent, paddingHorizontal: space.s6, paddingBottom: space.s8 },
    sep: { height: space.s4 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.bgElevated,
      borderWidth: hairline,
      borderColor: c.hairline,
      borderRadius: radius.lg,
      paddingVertical: space.s5,
      paddingLeft: space.s5,
      paddingRight: space.s4,
      gap: space.s3,
    },
    rowMain: { flex: 1 },
    rowName: {
      ...t.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },
    rowMeta: {
      ...t.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      marginTop: space.s1,
      marginBottom: space.s3,
    },
    track: {
      height: 4,
      borderRadius: radius.pill,
      backgroundColor: c.bgSubtle,
      overflow: 'hidden',
    },
    fill: {
      height: 4,
      borderRadius: radius.pill,
      backgroundColor: c.appAccent,
    },
    iconBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },

    emptyWrap: { ...boundedContent, flexGrow: 1, justifyContent: 'center' },
    empty: { paddingHorizontal: space.s7, alignItems: 'center' },
    emptyTitle: {
      ...t.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      marginBottom: space.s3,
    },
    emptyBody: {
      ...t.base,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
      marginBottom: space.s6,
    },
    emptyBtn: {
      minHeight: target.min,
      justifyContent: 'center',
      paddingHorizontal: space.s7,
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
    },
    emptyBtnText: {
      ...t.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
  });
}
