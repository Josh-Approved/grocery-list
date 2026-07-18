/**
 * List detail — the core screen.
 *
 * Add items (auto-sorted into aisles), tap to check them off, adjust
 * quantities. Crossing an item off is a small tangible moment (light haptic +
 * a brief toast with Undo), because accidental check/delete is the universal
 * grocery-app complaint and the tenet here is "hard to lose."
 *
 * Checked items dim and sink into a group so the working list stays what's
 * left to get. There is deliberately NO moment-in-time "finish shop" gate
 * (removed 2026-07-15): clearing crossed-off items is ambient — a "Clear" on
 * the Checked header, plus a gentle prompt to clear last shop's leftovers when
 * you reopen the list. Nothing important hinges on remembering a tap.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  ChevronLeft,
  MoreHorizontal,
  Plus,
  Pencil,
  ChevronDown,
  ChevronRight,
  Link2,
  Share2,
  X,
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
import { SwipeRow } from '../components/SwipeRow';
import { SyncStatusBar } from '../components/SyncStatusBar';
import { useActionMenu, usePrompt } from '../components/Dialogs';
import { useItemEditor } from '../components/ItemEditor';
import AddItemsSheet from '../components/AddItemsSheet';
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

// Checked items whose most-recent cross-off is older than this are treated as
// "left over from a previous shop" — the trigger for the gentle reopen prompt
// to tidy them. Long enough that a single long shop never trips it.
const STALE_CHECKED_MS = 6 * 60 * 60 * 1000; // 6 hours

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
  const clearChecked = useListsStore((st) => st.clearChecked);
  const restoreItems = useListsStore((st) => st.restoreItems);

  const recordUse = useAccountStore((st) => st.recordUse);
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
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  // Checked items move into a group that's open by default — crossing
  // something off should visibly land it somewhere, not vanish behind a
  // collapsed header (Josh, 2026-06-19).
  const [checkedOpen, setCheckedOpen] = useState(true);
  // The reopen "clear last shop's leftovers?" prompt is dismissible for the
  // session; clearing also resolves it. Resets on next open (a fresh mount).
  const [stalePromptDismissed, setStalePromptDismissed] = useState(false);
  const [reviewVisible, setReviewVisible] = useState(false);
  const [snack, setSnack] = useState<{
    message: string;
    undo: () => void;
  } | null>(null);

  // The list can vanish (deleted elsewhere / a synced delete). Leave.
  // NOTE: every hook below runs unconditionally — the `!list` early return
  // lives just above the JSX, after all hooks (Rules of Hooks).
  useEffect(() => {
    if (!list) navigation.goBack();
  }, [list, navigation]);

  const stats = list ? listStats(list) : { total: 0, checked: 0 };

  // How many crossed-off items look left over from a previous shop. Recomputed
  // when the list changes; the newest cross-off gates it (checkedItems is
  // sorted most-recent-first), so items checked during THIS shop never count.
  const staleCheckedCount = useMemo(() => {
    if (!list) return 0;
    const done = checkedItems(list);
    if (done.length === 0) return 0;
    const newest = done[0].checkedAt ?? 0;
    return Date.now() - newest > STALE_CHECKED_MS ? done.length : 0;
  }, [list]);
  const showStalePrompt = !stalePromptDismissed && staleCheckedCount > 0;

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

  // Crossing an item off: a small tangible beat. Light haptic + a brief toast
  // with Undo when you check something ON; unchecking is silent (no false
  // "done" signal). Undo just flips the check back.
  const toggleChecked = useCallback(
    (item: GroceryItem) => {
      const next = !item.checked;
      setChecked(listId, item.id, next);
      if (next) {
        Haptics.selectionAsync().catch(() => {});
        setSnack({
          message: t('detail.crossedOff', { name: item.name }),
          undo: () => setChecked(listId, item.id, false),
        });
      }
    },
    [setChecked, listId]
  );

  const doClearChecked = useCallback(() => {
    const snaps = clearChecked(listId);
    if (snaps.length === 0) return;
    // Clearing resolves the reopen prompt too.
    setStalePromptDismissed(true);
    setSnack({
      message: t(
        snaps.length === 1 ? 'detail.clearedOne' : 'detail.clearedOther',
        { count: snaps.length }
      ),
      undo: () => restoreItems(listId, snaps),
    });
    // Clearing what you bought is this app's genuine "successful shop" — the
    // canonical review prompt's only trigger here (never on launch/error).
    // Re-anchored from the removed "Finish shop" gate (2026-07-15).
    recordSuccessfulCompletion()
      .then((show) => {
        if (show) setReviewVisible(true);
      })
      .catch(() => {});
  }, [clearChecked, restoreItems, listId]);

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
                label: t('detail.clearCheckedMenu', { count: stats.checked }),
                onPress: doClearChecked,
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
    doClearChecked,
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
          <View style={s.checkedHeader}>
            <Pressable
              style={({ pressed }) => [s.checkedToggle, pressed && s.pressed]}
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
            <Pressable
              onPress={doClearChecked}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('detail.clearCheckedA11y', {
                count: row.count,
              })}
              style={({ pressed }) => [s.clearBtn, pressed && s.pressed]}
            >
              <Text style={s.clearBtnText}>{t('detail.clearChecked')}</Text>
            </Pressable>
          </View>
        );
      }
      const it = row.item;
      return (
        <SwipeRow
          onDelete={() => removeWithUndo(it)}
          actionLabel={t('common.delete')}
          accessibilityLabel={t('detail.swipeToDeleteA11y', { name: it.name })}
        >
        <View style={[s.itemRow, row.divider && s.itemDivider]}>
          <Pressable
            style={s.itemTap}
            onPress={() => toggleChecked(it)}
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
        </SwipeRow>
      );
    },
    [s, c, listId, checkedOpen, toggleChecked, doClearChecked, removeWithUndo, openEditor]
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
          onPress={() => navigation.navigate('Share', { listId })}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t(
            list.shareIdentity ? 'detail.sharingSettings' : 'detail.shareThis'
          )}
          style={({ pressed }) => [s.iconBtn, pressed && s.pressed]}
        >
          <Share2 size={22} color={c.fg} strokeWidth={1.5} />
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

      {list.shareIdentity && (
        <SyncStatusBar secret={list.shareIdentity.secret} />
      )}

      <View style={s.addBar}>
        <Pressable
          onPress={() => setAddSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t('detail.addItem')}
          style={({ pressed }) => [s.addTrigger, pressed && s.pressed]}
        >
          <Text style={s.addTriggerText}>{t('detail.addItem')}</Text>
          <Plus size={20} color={c.accent} strokeWidth={2} />
        </Pressable>
      </View>

      {showStalePrompt ? (
        <View style={s.staleBar} accessibilityLiveRegion="polite">
          <Text style={s.staleText} numberOfLines={2}>
            {t(
              staleCheckedCount === 1
                ? 'detail.clearPromptOne'
                : 'detail.clearPromptOther',
              { count: staleCheckedCount }
            )}
          </Text>
          <Pressable
            onPress={doClearChecked}
            accessibilityRole="button"
            accessibilityLabel={t('detail.clearCheckedA11y', {
              count: staleCheckedCount,
            })}
            style={({ pressed }) => [s.staleAction, pressed && s.pressed]}
          >
            <Text style={s.staleActionText}>{t('detail.clearChecked')}</Text>
          </Pressable>
          <Pressable
            onPress={() => setStalePromptDismissed(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            style={({ pressed }) => [s.staleDismiss, pressed && s.pressed]}
          >
            <X size={18} color={c.fgMuted} strokeWidth={1.5} />
          </Pressable>
        </View>
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

      <AddItemsSheet
        visible={addSheetOpen}
        listId={listId}
        onClose={() => setAddSheetOpen(false)}
      />

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
      color: c.fgSubtle,
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
      justifyContent: 'space-between',
      minHeight: target.min,
      marginTop: space.s5,
    },
    checkedToggle: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
      minHeight: target.min,
    },
    checkedHeaderText: {
      ...ty.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    clearBtn: {
      minHeight: target.min,
      justifyContent: 'center',
      paddingLeft: space.s4,
    },
    clearBtnText: {
      ...ty.sm,
      fontFamily: fontFamily.sansSemibold,
      color: c.accent,
    },

    staleBar: {
      ...boundedContent,
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: space.s6,
      marginBottom: space.s4,
      paddingLeft: space.s5,
      paddingRight: space.s2,
      minHeight: target.min,
      backgroundColor: c.bgElevated,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      borderRadius: radius.md,
    },
    staleText: {
      ...ty.sm,
      flex: 1,
      fontFamily: fontFamily.sans,
      color: c.fg,
      paddingVertical: space.s3,
    },
    staleAction: {
      minHeight: target.min,
      justifyContent: 'center',
      paddingHorizontal: space.s3,
    },
    staleActionText: {
      ...ty.sm,
      fontFamily: fontFamily.sansSemibold,
      color: c.accent,
    },
    staleDismiss: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
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

  });
}
