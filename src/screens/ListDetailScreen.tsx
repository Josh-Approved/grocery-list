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
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  MoreHorizontal,
  Plus,
  Pencil,
  ChevronDown,
  ChevronRight,
  Link2,
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
import { categoryLabel, type Category } from '../data/categories';
import { Snackbar } from '../components/Snackbar';
import { useActionMenu, usePrompt } from '../components/Dialogs';
import { useItemEditor } from '../components/ItemEditor';
import ReviewModal from '../components/ReviewModal';
import { recordSuccessfulCompletion } from '../storage/reviewPrompt';
import { APP_NAME, IOS_APP_STORE_ID, ANDROID_PACKAGE } from '../lib/links';
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
import { boundedContent } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ListDetail'>;

type Row =
  | { kind: 'section'; key: string; category: Category }
  | { kind: 'item'; key: string; item: GroceryItem; divider?: boolean }
  | { kind: 'checkedHeader'; key: string; count: number };

export default function ListDetailScreen({ route, navigation }: Props) {
  const { listId } = route.params;
  const { c } = useTheme();
  const s = makeStyles(c);

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const addItem = useListsStore((st) => st.addItem);
  const setChecked = useListsStore((st) => st.setChecked);
  const deleteItem = useListsStore((st) => st.deleteItem);
  const renameList = useListsStore((st) => st.renameList);
  const deleteList = useListsStore((st) => st.deleteList);
  const finishShop = useListsStore((st) => st.finishShop);
  const restoreItems = useListsStore((st) => st.restoreItems);

  const recordUse = useAccountStore((st) => st.recordUse);
  const suggest = useAccountStore((st) => st.suggest);
  const staples = useAccountStore((st) => st.staples);

  // The active in-app language, so a newly added item categorizes against that
  // language's keywords (System follows the device; an explicit pick wins).
  const { pref } = useLocalePreference();
  const activeLocale =
    pref === 'system'
      ? pickLocale(getLocale(), [...CANONICAL_LOCALES]) ?? 'en'
      : pref;

  const menu = useActionMenu();
  const prompt = usePrompt();
  const { open: openEditor, element: editorElement } = useItemEditor();
  const [draft, setDraft] = useState('');
  // Checked items move into a group that's open by default — crossing
  // something off should visibly land it somewhere, not vanish behind a
  // collapsed header (Josh, 2026-06-19).
  const [checkedOpen, setCheckedOpen] = useState(true);
  const [reviewVisible, setReviewVisible] = useState(false);
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
    // Hairline under every item except the final row of the list — so the last
    // item of a category is separated from the next category's header too, not
    // just consecutive items within a category (Josh, 2026-06-20).
    for (let i = 0; i < out.length; i++) {
      const r = out[i];
      if (r.kind === 'item') r.divider = i < out.length - 1;
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
      addItem(listId, n, activeLocale);
      recordUse(n);
      if (keepFocus) {
        setDraft('');
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    },
    [addItem, recordUse, listId, activeLocale]
  );

  const submitDraft = useCallback(() => {
    // The add box keeps the keyboard up after each add (blurOnSubmit={false})
    // so you can rapid-fire a whole list. But that means an empty submit has
    // no on-keyboard way out — tapping "done"/return on an empty box must be
    // read as "I'm finished" and dismiss the keyboard, not as a no-op.
    if (draft.trim()) {
      addOne(draft, true);
    } else {
      Keyboard.dismiss();
    }
  }, [addOne, draft]);

  const addUsuals = useCallback(() => {
    if (!list) return;
    const active = new Set(
      visibleItems(list).map((it) => it.name.toLowerCase())
    );
    for (const name of staples) {
      if (!active.has(name)) {
        addItem(listId, name, activeLocale);
        recordUse(name);
      }
    }
  }, [list, staples, addItem, recordUse, listId, activeLocale]);

  const removeWithUndo = useCallback(
    (item: GroceryItem) => {
      const snap = { ...item };
      deleteItem(listId, item.id);
      setSnack({
        message: t('detail.removed', { name: item.name }),
        undo: () => restoreItems(listId, [snap]),
      });
    },
    [deleteItem, restoreItems, listId]
  );

  const doFinishShop = useCallback(() => {
    const snaps = finishShop(listId);
    if (snaps.length === 0) return;
    setSnack({
      message: t(
        snaps.length === 1 ? 'detail.clearedOne' : 'detail.clearedOther',
        { count: snaps.length }
      ),
      undo: () => restoreItems(listId, snaps),
    });
    // Finishing a shop is this app's genuine "satisfying success" — the
    // canonical review prompt's only trigger here (never on launch/error).
    recordSuccessfulCompletion()
      .then((show) => {
        if (show) setReviewVisible(true);
      })
      .catch(() => {});
  }, [finishShop, restoreItems, listId]);

  const openListMenu = useCallback(() => {
    if (!list) return;
    menu.open({
      title: list.name,
      options: [
        {
          label: t('detail.renameList'),
          onPress: () =>
            prompt.open({
              title: t('detail.renameList'),
              initialValue: list.name,
              selectAll: true,
              confirmLabel: t('common.save'),
              onSubmit: (name) => renameList(listId, name),
            }),
        },
        {
          label: list.shareIdentity
            ? t('detail.sharingSettings')
            : t('detail.shareThis'),
          onPress: () => navigation.navigate('Share', { listId }),
        },
        {
          label: t('detail.reorderAisles'),
          onPress: () => navigation.navigate('ReorderAisles', { listId }),
        },
        ...(staples.length > 0
          ? [{ label: t('detail.addUsuals'), onPress: addUsuals }]
          : []),
        ...(stats.checked > 0
          ? [
              {
                label: t('detail.finishShopClear', { count: stats.checked }),
                onPress: doFinishShop,
              },
            ]
          : []),
        {
          label: t('detail.deleteList'),
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
            {categoryLabel(row.category)}
          </Text>
        );
      }
      if (row.kind === 'checkedHeader') {
        return (
          <Pressable
            style={({ pressed }) => [s.checkedHeader, pressed && s.pressed]}
            onPress={() => setCheckedOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={t('detail.checkedA11y', {
              count: row.count,
              state: checkedOpen ? t('detail.collapse') : t('detail.expand'),
            })}
          >
            {checkedOpen ? (
              <ChevronDown size={16} color={c.fgMuted} strokeWidth={1.5} />
            ) : (
              <ChevronRight size={16} color={c.fgMuted} strokeWidth={1.5} />
            )}
            <Text style={s.checkedHeaderText}>
              {t('detail.checked', { count: row.count })}
            </Text>
          </Pressable>
        );
      }
      const it = row.item;
      return (
        <View style={[s.itemRow, row.divider && s.itemDivider]}>
          <Pressable
            style={s.itemTap}
            onPress={() => setChecked(listId, it.id, !it.checked)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: it.checked }}
            accessibilityLabel={
              it.quantity > 1
                ? t('detail.itemWithQtyA11y', {
                    name: it.name,
                    count: it.quantity,
                  })
                : it.name
            }
          >
            <Text style={[s.itemName, it.checked && s.itemNameChecked]}>
              {it.name}
            </Text>
            {it.note ? (
              <Text style={[s.itemNote, it.checked && s.itemNoteChecked]}>
                {it.note}
              </Text>
            ) : null}
          </Pressable>

          {it.quantity > 1 ? (
            <View
              style={s.qtyBadge}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={s.qtyBadgeText}>{`×${it.quantity}`}</Text>
            </View>
          ) : null}
          <Pressable
            onPress={() =>
              openEditor({ listId, itemId: it.id, onRemove: removeWithUndo })
            }
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('detail.editItemA11y', { name: it.name })}
            style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
          >
            <Pencil size={18} color={c.fgMuted} strokeWidth={1.5} />
          </Pressable>
        </View>
      );
    },
    [s, c, listId, checkedOpen, setChecked, removeWithUndo, openEditor]
  );

  if (!list) return null;

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
              title: t('detail.renameList'),
              initialValue: list.name,
              selectAll: true,
              confirmLabel: t('common.save'),
              onSubmit: (name) => renameList(listId, name),
            })
          }
          accessibilityRole="button"
          accessibilityLabel={t(
            list.shareIdentity ? 'detail.renameSharedA11y' : 'detail.renameA11y',
            { name: list.name }
          )}
        >
          <View style={s.titleRow}>
            <Text style={s.headerTitle} numberOfLines={1}>
              {list.name}
            </Text>
            {list.shareIdentity && (
              <Link2
                size={16}
                color={c.accent}
                strokeWidth={2}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
            )}
          </View>
          <Text style={s.headerMeta}>
            {stats.total === 0
              ? t('common.empty')
              : t('common.countChecked', {
                  checked: stats.checked,
                  total: stats.total,
                })}
          </Text>
        </Pressable>
        <Pressable
          onPress={openListMenu}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('detail.listOptions')}
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
          placeholder={t('detail.addItem')}
          placeholderTextColor={c.fgSubtle}
          returnKeyType="done"
          blurOnSubmit={false}
          onSubmitEditing={submitDraft}
          accessibilityLabel={t('detail.addItem')}
        />
        <Pressable
          onPress={submitDraft}
          disabled={draft.trim().length === 0}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t('detail.addItemButton')}
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
              accessibilityLabel={t('detail.addNamed', { name })}
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
            <Text style={s.emptyTitle}>{t('detail.emptyTitle')}</Text>
            <Text style={s.emptyBody}>{t('detail.emptyBody')}</Text>
          </View>
        }
      />

      {stats.checked > 0 ? (
        <View style={s.finishWrap}>
          <Pressable
            onPress={doFinishShop}
            accessibilityRole="button"
            accessibilityLabel={t('detail.finishShopA11y', {
              count: stats.checked,
            })}
            style={({ pressed }) => [s.finishBtn, pressed && s.pressed]}
          >
            <Text style={s.finishText}>
              {t('detail.finishShop', { count: stats.checked })}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <Snackbar
        visible={!!snack}
        message={snack?.message ?? ''}
        actionLabel={t('common.undo')}
        onAction={() => snack?.undo()}
        onDismiss={() => setSnack(null)}
      />

      <ReviewModal
        visible={reviewVisible}
        onDismiss={() => setReviewVisible(false)}
        appName={APP_NAME}
        iosAppStoreId={IOS_APP_STORE_ID}
        androidPackageName={ANDROID_PACKAGE}
      />

      {menu.element}
      {prompt.element}
      {editorElement}
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
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
    },
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
      gap: space.s3,
    },
    addInput: {
      ...ty.base,
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
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fg,
      maxWidth: 180,
    },

    listContent: {
      ...boundedContent,
      paddingHorizontal: space.s6,
      paddingBottom: space.s9,
    },
    sectionHeader: {
      ...ty.xs,
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
      ...ty.xs,
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
    itemDivider: {
      borderBottomWidth: hairline,
      borderBottomColor: c.hairline,
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
    itemNameChecked: {
      color: c.fgSubtle,
      textDecorationLine: 'line-through',
    },
    itemNote: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      marginTop: space.s1,
    },
    itemNoteChecked: {
      color: c.fgSubtle,
      textDecorationLine: 'line-through',
    },
    qtyBadge: {
      paddingHorizontal: space.s3,
      paddingVertical: space.s1,
      borderRadius: radius.md,
      backgroundColor: c.bgSubtle,
    },
    qtyBadgeText: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      fontVariant: ['tabular-nums'],
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
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
  });
}
