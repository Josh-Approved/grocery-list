/**
 * Kits home — every kit the user has, newest first.
 *
 * A kit is a reusable bundle of items you buy together for one thing you make.
 * Create one, open it to edit, or rename / duplicate / delete via a per-row
 * overflow menu (cross-platform `Dialogs`, never ActionSheetIOS). You select a
 * kit while adding to a list (the Add-items sheet's Kits tab) — you don't add
 * kits here, you build and keep them.
 *
 * Sibling of ListsHomeScreen; same row + header + empty-state shapes.
 */

import React, { useCallback } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Plus, MoreHorizontal, ChevronRight, Settings } from 'lucide-react-native';
import type { KitsTabProps } from './navTypes';
import { useKitsStore } from '../store/kits';
import { kitItemCount, visibleKits, type Kit } from '../data/kit';
import { useActionMenu, usePrompt, useConfirm } from '../components/Dialogs';
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

type Props = KitsTabProps;

export default function KitsHomeScreen({ navigation }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const kits = useKitsStore((st) => st.kits);
  const createKit = useKitsStore((st) => st.createKit);
  const renameKit = useKitsStore((st) => st.renameKit);
  const duplicateKit = useKitsStore((st) => st.duplicateKit);
  const deleteKit = useKitsStore((st) => st.deleteKit);

  const menu = useActionMenu();
  const prompt = usePrompt();
  const confirm = useConfirm();

  // Live kits, newest activity first.
  const data = React.useMemo(
    () => visibleKits(kits).sort((a, b) => b.updatedAt - a.updatedAt),
    [kits]
  );

  const newKit = useCallback(() => {
    prompt.open({
      title: t('kits.newKit'),
      placeholder: t('kits.newKitPlaceholder'),
      confirmLabel: t('common.create'),
      onSubmit: (name) => {
        const id = createKit(name);
        navigation.navigate('KitDetail', { kitId: id });
      },
    });
  }, [prompt, createKit, navigation]);

  const openMenu = useCallback(
    (kit: Kit) => {
      menu.open({
        title: kit.name,
        options: [
          {
            label: t('common.rename'),
            onPress: () =>
              prompt.open({
                title: t('kits.renameKit'),
                initialValue: kit.name,
                selectAll: true,
                confirmLabel: t('common.save'),
                onSubmit: (name) => renameKit(kit.id, name),
              }),
          },
          {
            label: t('kits.duplicate'),
            onPress: () => duplicateKit(kit.id),
          },
          {
            label: t('common.delete'),
            destructive: true,
            onPress: () =>
              confirm.open({
                title: t('kits.deleteKit'),
                message: t('kits.deleteKitConfirm'),
                confirmLabel: t('common.delete'),
                destructive: true,
                onConfirm: () => deleteKit(kit.id),
              }),
          },
        ],
      });
    },
    [menu, prompt, confirm, renameKit, duplicateKit, deleteKit]
  );

  const renderItem = useCallback(
    ({ item }: { item: Kit }) => {
      const count = kitItemCount(item);
      return (
        <Pressable
          style={({ pressed }) => [s.row, pressed && s.rowPressed]}
          onPress={() => navigation.navigate('KitDetail', { kitId: item.id })}
          accessibilityRole="button"
          accessibilityLabel={t('kits.kitSummary', { name: item.name, count })}
        >
          <View style={s.rowMain}>
            <Text style={s.rowName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={s.rowMeta}>
              {count === 0
                ? t('common.empty')
                : t(count === 1 ? 'kits.itemsOne' : 'kits.itemsOther', { count })}
            </Text>
          </View>
          <Pressable
            onPress={() => openMenu(item)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('common.optionsFor', { name: item.name })}
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
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right']}>
      <View style={s.header}>
        <View style={s.headerText}>
          <Text style={s.title}>{t('kits.title')}</Text>
          <Text style={s.subtitle}>{t('kits.subtitle')}</Text>
        </View>
        <Pressable
          onPress={newKit}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('kits.newKit')}
          style={({ pressed }) => [s.newBtn, pressed && s.rowPressed]}
        >
          <Plus size={18} color={c.fg} strokeWidth={1.5} />
          <Text style={s.newBtnText}>{t('kits.newKit')}</Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('Settings')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('settings.title')}
          style={({ pressed }) => [s.iconBtn, pressed && s.rowPressed]}
        >
          <Settings size={20} color={c.fgMuted} strokeWidth={1.5} />
        </Pressable>
      </View>

      <FlatList
        style={s.flex}
        data={data}
        keyExtractor={(k: Kit) => k.id}
        renderItem={renderItem}
        contentContainerStyle={data.length === 0 ? s.emptyWrap : s.listContent}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyTitle}>{t('kits.emptyTitle')}</Text>
            <Text style={s.emptyBody}>{t('kits.emptyBody')}</Text>
            <Pressable
              onPress={newKit}
              accessibilityRole="button"
              accessibilityLabel={t('kits.createFirst')}
              style={({ pressed }) => [s.emptyBtn, pressed && s.rowPressed]}
            >
              <Text style={s.emptyBtnText}>{t('kits.createKit')}</Text>
            </Pressable>
          </View>
        }
      />

      {menu.element}
      {prompt.element}
      {confirm.element}
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
      ...ty.sm,
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
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },

    listContent: {
      ...boundedContent,
      flexGrow: 1,
      paddingHorizontal: space.s6,
      paddingBottom: space.s8,
    },
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
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      flexShrink: 1,
    },
    rowMeta: {
      ...ty.sm,
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
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
  });
}
