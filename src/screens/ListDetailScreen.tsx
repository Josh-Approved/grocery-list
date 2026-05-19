/**
 * List detail — the core screen.
 *
 * Add items (auto-sorted into aisles), tap to check them off, adjust
 * quantities, and "Finish shop" to clear what you bought — with Undo, because
 * accidental check/delete is the universal grocery-app complaint and the
 * tenet here is "hard to lose."
 *
 * Checked items dim and sink into a collapsed group so the working list stays
 * what's left to get. Sharing (build step 4) will surface here later.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  MoreHorizontal,
  Plus,
  Check,
  ChevronDown,
  ChevronRight,
} from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useListsStore } from '../store/lists';
import { useAccountStore } from '../store/account';
import {
  checkedItems,
  groupUnchecked,
  listStats,
  visibleItems,
  type GroceryItem,
} from '../data/list';
import { DEFAULT_CATEGORY_ORDER, type Category } from '../data/categories';
import { Stepper } from '../components/Stepper';
import { Snackbar } from '../components/Snackbar';
import { useActionMenu, usePrompt } from '../components/Dialogs';
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

type Props = NativeStackScreenProps<RootStackParamList, 'ListDetail'>;

type Row =
  | { kind: 'section'; key: string; category: Category }
  | { kind: 'item'; key: string; item: GroceryItem }
  | { kind: 'checkedHeader'; key: string; count: number };

export default function ListDetailScreen({ route, navigation }: Props) {
  const { listId } = route.params;
  const { c } = useTheme();
  const s = makeStyles(c);

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const addItem = useListsStore((st) => st.addItem);
  const setChecked = useListsStore((st) => st.setChecked);
  const setQuantity = useListsStore((st) => st.setQuantity);
  const setNote = useListsStore((st) => st.setNote);
  const recategorize = useListsStore((st) => st.recategorize);
  const deleteItem = useListsStore((st) => st.deleteItem);
  const renameList = useListsStore((st) => st.renameList);
  const deleteList = useListsStore((st) => st.deleteList);
  const finishShop = useListsStore((st) => st.finishShop);
  const restoreItems = useListsStore((st) => st.restoreItems);

  const recordUse = useAccountStore((st) => st.recordUse);
  const suggest = useAccountStore((st) => st.suggest);
  const isStaple = useAccountStore((st) => st.isStaple);
  const addStaple = useAccountStore((st) => st.addStaple);
  const removeStaple = useAccountStore((st) => st.removeStaple);
  const staples = useAccountStore((st) => st.staples);

  const menu = useActionMenu();
  const prompt = usePrompt();
  const [draft, setDraft] = useState('');
  const [checkedOpen, setCheckedOpen] = useState(false);
  const [snack, setSnack] = useState<{
    message: string;
    undo: () => void;
  } | null>(null);
  const inputRef = useRef<TextInput>(null);

  // The list can vanish (deleted elsewhere / a synced delete). Leave.
  // NOTE: every hook below runs unconditionally — the `!list` early return
  // lives just above the JSX, after all hooks (Rules of Hooks).
  useEffect(() => {
    if (!list) navigation.goBack();
  }, [list, navigation]);

  const stats = list ? listStats(list) : { total: 0, checked: 0 };

  const rows: Row[] = useMemo(() => {
    if (!list) return [];
    const out: Row[] = [];
    for (const sec of groupUnchecked(list)) {
      out.push({
        kind: 'section',
        key: `sec-${sec.category}`,
        category: sec.category,
      });
      for (const it of sec.items) {
        out.push({ kind: 'item', key: it.id, item: it });
      }
    }
    const done = checkedItems(list);
    if (done.length > 0) {
      out.push({
        kind: 'checkedHeader',
        key: 'checked-header',
        count: done.length,
      });
      if (checkedOpen) {
        for (const it of done) {
          out.push({ kind: 'item', key: it.id, item: it });
        }
      }
    }
    return out;
  }, [list, checkedOpen]);

  const activeNames = useMemo(
    () => (list ? visibleItems(list).map((it) => it.name) : []),
    [list]
  );

  const suggestions = useMemo(
    () => (draft.trim() ? suggest(draft, activeNames, 5) : []),
    [draft, activeNames, suggest]
  );

  const addOne = useCallback(
    (name: string, keepFocus: boolean) => {
      const n = name.trim();
      if (!n) return;
      addItem(listId, n);
      recordUse(n);
      if (keepFocus) {
        setDraft('');
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    },
    [addItem, recordUse, listId]
  );

  const submitDraft = useCallback(() => {
    addOne(draft, true);
  }, [addOne, draft]);

  const addUsuals = useCallback(() => {
    if (!list) return;
    const active = new Set(
      visibleItems(list).map((it) => it.name.toLowerCase())
    );
    for (const name of staples) {
      if (!active.has(name)) {
        addItem(listId, name);
        recordUse(name);
      }
    }
  }, [list, staples, addItem, recordUse, listId]);

  const removeWithUndo = useCallback(
    (item: GroceryItem) => {
      const snap = { ...item };
      deleteItem(listId, item.id);
      setSnack({
        message: `Removed ${item.name}`,
        undo: () => restoreItems(listId, [snap]),
      });
    },
    [deleteItem, restoreItems, listId]
  );

  const doFinishShop = useCallback(() => {
    const snaps = finishShop(listId);
    if (snaps.length === 0) return;
    setSnack({
      message: `Cleared ${snaps.length} item${snaps.length === 1 ? '' : 's'}`,
      undo: () => restoreItems(listId, snaps),
    });
  }, [finishShop, restoreItems, listId]);

  const openItemMenu = useCallback(
    (item: GroceryItem) => {
      menu.open({
        title: item.name,
        options: [
          {
            label: item.note ? 'Edit note' : 'Add a note',
            onPress: () =>
              prompt.open({
                title: 'Note',
                message: 'Brand, size, anything useful at the shelf.',
                initialValue: item.note ?? '',
                selectAll: true,
                placeholder: 'e.g. the big one',
                onSubmit: (text) => setNote(listId, item.id, text),
              }),
          },
          {
            label: 'Move to aisle',
            onPress: () =>
              menu.open({
                title: 'Move to aisle',
                options: DEFAULT_CATEGORY_ORDER.map((cat) => ({
                  label: cat === item.category ? `${cat} ✓` : cat,
                  onPress: () => recategorize(listId, item.id, cat),
                })),
              }),
          },
          {
            label: isStaple(item.name)
              ? 'Remove from usuals'
              : 'Save as a usual',
            onPress: () =>
              isStaple(item.name)
                ? removeStaple(item.name)
                : addStaple(item.name),
          },
          {
            label: 'Remove',
            destructive: true,
            onPress: () => removeWithUndo(item),
          },
        ],
      });
    },
    [
      menu,
      prompt,
      setNote,
      recategorize,
      removeWithUndo,
      listId,
      isStaple,
      addStaple,
      removeStaple,
    ]
  );

  const openListMenu = useCallback(() => {
    if (!list) return;
    menu.open({
      title: list.name,
      options: [
        {
          label: 'Rename list',
          onPress: () =>
            prompt.open({
              title: 'Rename list',
              initialValue: list.name,
              selectAll: true,
              confirmLabel: 'Save',
              onSubmit: (name) => renameList(listId, name),
            }),
        },
        {
          label: 'Reorder aisles',
          onPress: () => navigation.navigate('ReorderAisles', { listId }),
        },
        ...(staples.length > 0
          ? [{ label: 'Add usuals', onPress: addUsuals }]
          : []),
        ...(stats.checked > 0
          ? [
              {
                label: `Finish shop (clear ${stats.checked})`,
                onPress: doFinishShop,
              },
            ]
          : []),
        {
          label: 'Delete list',
          destructive: true,
          onPress: () => {
            deleteList(listId);
            navigation.goBack();
          },
        },
      ],
    });
  }, [
    menu,
    prompt,
    list,
    stats.checked,
    staples.length,
    addUsuals,
    doFinishShop,
    renameList,
    deleteList,
    navigation,
    listId,
  ]);

  const renderRow = useCallback(
    ({ item: row }: { item: Row }) => {
      if (row.kind === 'section') {
        return (
          <Text style={s.sectionHeader} accessibilityRole="header">
            {row.category}
          </Text>
        );
      }
      if (row.kind === 'checkedHeader') {
        return (
          <Pressable
            style={({ pressed }) => [s.checkedHeader, pressed && s.pressed]}
            onPress={() => setCheckedOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={`Checked, ${row.count} items, ${
              checkedOpen ? 'collapse' : 'expand'
            }`}
          >
            {checkedOpen ? (
              <ChevronDown size={16} color={c.fgMuted} strokeWidth={1.5} />
            ) : (
              <ChevronRight size={16} color={c.fgMuted} strokeWidth={1.5} />
            )}
            <Text style={s.checkedHeaderText}>
              Checked ({row.count})
            </Text>
          </Pressable>
        );
      }
      const it = row.item;
      return (
        <View style={s.itemRow}>
          <Pressable
            style={s.itemTap}
            onPress={() => setChecked(listId, it.id, !it.checked)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: it.checked }}
            accessibilityLabel={it.name}
          >
            <View style={[s.box, it.checked && s.boxOn]}>
              {it.checked ? (
                <Check size={14} color={c.fgOnAccent} strokeWidth={3} />
              ) : null}
            </View>
            <View style={s.itemText}>
              <Text
                style={[s.itemName, it.checked && s.itemNameChecked]}
                numberOfLines={1}
              >
                {it.name}
              </Text>
              {it.note ? (
                <Text style={s.itemNote} numberOfLines={1}>
                  {it.note}
                </Text>
              ) : null}
            </View>
          </Pressable>

          {it.checked ? null : (
            <Stepper
              value={it.quantity}
              onChange={(q) => setQuantity(listId, it.id, q)}
              onRemove={() => removeWithUndo(it)}
              label={`Quantity of ${it.name}`}
            />
          )}
          <Pressable
            onPress={() => openItemMenu(it)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Options for ${it.name}`}
            style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
          >
            <MoreHorizontal size={20} color={c.fgMuted} strokeWidth={1.5} />
          </Pressable>
        </View>
      );
    },
    [s, c, listId, checkedOpen, setChecked, setQuantity, removeWithUndo, openItemMenu]
  );

  if (!list) return null;

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
        <Pressable
          style={s.headerTitleWrap}
          onPress={() =>
            prompt.open({
              title: 'Rename list',
              initialValue: list.name,
              selectAll: true,
              confirmLabel: 'Save',
              onSubmit: (name) => renameList(listId, name),
            })
          }
          accessibilityRole="button"
          accessibilityLabel={`${list.name}, rename`}
        >
          <Text style={s.headerTitle} numberOfLines={1}>
            {list.name}
          </Text>
          <Text style={s.headerMeta}>
            {stats.total === 0
              ? 'Empty'
              : `${stats.checked} of ${stats.total} checked`}
          </Text>
        </Pressable>
        <Pressable
          onPress={openListMenu}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="List options"
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
        >
          <MoreHorizontal size={22} color={c.fg} strokeWidth={1.5} />
        </Pressable>
      </View>

      <View style={s.addBar}>
        <TextInput
          ref={inputRef}
          style={s.addInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Add an item"
          placeholderTextColor={c.fgSubtle}
          returnKeyType="done"
          blurOnSubmit={false}
          onSubmitEditing={submitDraft}
          accessibilityLabel="Add an item"
        />
        <Pressable
          onPress={submitDraft}
          disabled={draft.trim().length === 0}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Add item"
          style={({ pressed }) => [
            s.addBtn,
            draft.trim().length === 0 && s.addBtnDisabled,
            pressed && s.pressed,
          ]}
        >
          <Plus size={20} color={c.inkButtonText} strokeWidth={2} />
        </Pressable>
      </View>

      {suggestions.length > 0 ? (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.suggestRow}
        >
          {suggestions.map((name) => (
            <Pressable
              key={name}
              onPress={() => addOne(name, true)}
              accessibilityRole="button"
              accessibilityLabel={`Add ${name}`}
              style={({ pressed }) => [s.chip, pressed && s.pressed]}
            >
              <Plus size={14} color={c.fgMuted} strokeWidth={1.5} />
              <Text style={s.chipText} numberOfLines={1}>
                {name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={
          rows.length === 0 ? s.emptyWrap : s.listContent
        }
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyTitle}>Nothing on this list yet</Text>
            <Text style={s.emptyBody}>
              Type an item above and it'll sort itself into the right aisle.
            </Text>
          </View>
        }
      />

      {stats.checked > 0 ? (
        <View style={s.finishWrap}>
          <Pressable
            onPress={doFinishShop}
            accessibilityRole="button"
            accessibilityLabel={`Finish shop, clear ${stats.checked} checked items`}
            style={({ pressed }) => [s.finishBtn, pressed && s.pressed]}
          >
            <Text style={s.finishText}>Finish shop ({stats.checked})</Text>
          </Pressable>
        </View>
      ) : null}

      <Snackbar
        visible={!!snack}
        message={snack?.message ?? ''}
        actionLabel="Undo"
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
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.s4,
      paddingVertical: space.s3,
      gap: space.s2,
    },
    headerTitleWrap: { flex: 1, paddingHorizontal: space.s3 },
    headerTitle: {
      ...t.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },
    headerMeta: {
      ...t.xs,
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
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.s6,
      paddingBottom: space.s4,
      gap: space.s3,
    },
    addInput: {
      ...t.base,
      flex: 1,
      fontFamily: fontFamily.sans,
      color: c.fg,
      backgroundColor: c.bgElevated,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      borderRadius: radius.md,
      paddingHorizontal: space.s5,
      minHeight: target.min,
    },
    addBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
    },
    addBtnDisabled: { opacity: 0.4 },

    suggestRow: {
      paddingHorizontal: space.s6,
      paddingBottom: space.s4,
      gap: space.s3,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
      minHeight: 36,
      paddingHorizontal: space.s4,
      borderRadius: radius.pill,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      backgroundColor: c.bgElevated,
    },
    chipText: {
      ...t.sm,
      fontFamily: fontFamily.sans,
      color: c.fg,
      maxWidth: 180,
    },

    listContent: {
      paddingHorizontal: space.s6,
      paddingBottom: space.s9,
    },
    sectionHeader: {
      ...t.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: space.s5,
      marginBottom: space.s3,
    },
    checkedHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
      minHeight: target.min,
      marginTop: space.s5,
    },
    checkedHeaderText: {
      ...t.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },

    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: space.s3,
      gap: space.s3,
    },
    itemTap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: target.min,
      gap: space.s4,
    },
    box: {
      width: 24,
      height: 24,
      borderRadius: radius.sm,
      borderWidth: 1.5,
      borderColor: c.hairlineStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxOn: {
      backgroundColor: c.accent,
      borderColor: c.accent,
    },
    itemText: { flex: 1 },
    itemName: {
      ...t.base,
      fontFamily: fontFamily.sans,
      color: c.fg,
    },
    itemNameChecked: {
      color: c.fgSubtle,
      textDecorationLine: 'line-through',
    },
    itemNote: {
      ...t.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      marginTop: space.s1,
    },

    emptyWrap: { flexGrow: 1, justifyContent: 'center' },
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
    },

    finishWrap: {
      paddingHorizontal: space.s6,
      paddingTop: space.s4,
      paddingBottom: space.s4,
      borderTopWidth: hairline,
      borderTopColor: c.hairline,
      backgroundColor: c.bg,
    },
    finishBtn: {
      minHeight: target.min,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
    },
    finishText: {
      ...t.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
  });
}
