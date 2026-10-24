/**
 * Edge-inset audit over this app's own screens — APP-OWNED: seeded once by
 * `sync.mjs qa`, never overwritten.
 *
 * src/qa/edgeInset.ts (canonical) fails when text or an icon sits closer than
 * 8pt to the inside edge of a card, sheet, row or button; the canonical
 * edgeInset.proof.test.tsx proves it catches the shape that shipped.
 *
 * What belongs here: Settings, and every screen, sheet or pane that draws a
 * card, a filled or bordered row, or a labelled button. Each renders with two
 * lists (one shared, with items in a few aisles, a quantity, a note and a
 * crossed-off leftover), a kit, and some history and usuals on file, so its
 * rows, cards and pills actually appear. A sheet that only opens from a tap
 * (the Language and Siri pickers) is opened through auditScreen's `interact`
 * step, then audited. A new screen or sheet gets a line here in the same PR. qa-canonical
 * `test/edge-inset-screens` warns while this file renders none of the app's
 * screens or components.
 *
 * Fixing a finding: give the content room inside the surface, usually the
 * container's own `paddingHorizontal` matching its neighbours, rather than
 * padding each row.
 */

import React, { useEffect } from 'react';
import { screen, userEvent } from '@testing-library/react-native';

jest.mock('expo-haptics', () => ({
  selectionAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  NotificationFeedbackType: { Warning: 'warning' },
}));
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// The stores import ./db (real SQLite); state lives in memory instead.
jest.mock('../../store/db', () => ({
  loadHistory: () => Promise.resolve([]),
  recordHistory: () => Promise.resolve(),
  deleteHistory: () => Promise.resolve(),
  putHistory: () => Promise.resolve(),
  loadAllLists: () => Promise.resolve([]),
  saveList: () => Promise.resolve(),
  deleteListFromDb: () => Promise.resolve(),
  loadAllKits: () => Promise.resolve([]),
  saveKit: () => Promise.resolve(),
  putTombstone: () => Promise.resolve(),
  removeTombstone: () => Promise.resolve(),
  getSyncMeta: () => Promise.resolve(null),
  setSyncMeta: () => Promise.resolve(),
  getAppSetting: () => Promise.resolve(null),
  setAppSetting: () => Promise.resolve(),
}));
// The sync engine (relays, crypto) has no bearing on padding; the status
// store the sync bar reads stays real.
jest.mock('../../sync', () => ({ resyncNow: jest.fn() }));
// Siri is iOS-native; report it supported so Settings draws the Siri row.
jest.mock('../../siri', () => ({
  isSiriSupported: () => true,
  getSiriDefaultListId: () => Promise.resolve(null),
  setSiriDefaultListId: () => Promise.resolve(),
  syncListsToSiri: () => Promise.resolve(),
}));
jest.mock('../../lib/transfer', () => ({
  exportLists: jest.fn(() => Promise.resolve()),
  pickAndParseLists: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../lib/links', () => ({
  ...jest.requireActual('../../lib/links'),
  openReview: jest.fn(),
  openUrl: jest.fn(),
}));
jest.mock('../../storage/reviewPrompt', () => ({
  markReviewOpened: () => Promise.resolve(),
  markReviewPromptShown: () => Promise.resolve(),
}));
jest.mock('expo-store-review', () => ({
  isAvailableAsync: () => Promise.resolve(false),
  requestReview: () => Promise.resolve(),
}));
// Real price buttons, so the audit sees the tip tiers as they render.
jest.mock('../../lib/tipJar', () => {
  const { TIP_PRODUCT_IDS } = require('../../constants/tipProducts');
  return {
    isStoreKnownUnavailable: () => false,
    useTipJar: () => ({
      status: 'ready',
      products: TIP_PRODUCT_IDS.map((id: string) => ({ id, displayPrice: '$2.99' })),
      pendingSku: null,
      tip: jest.fn(),
    }),
  };
});
// The QR renderer and camera are native; the share screen's own layout stays real.
jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return function QRCode() {
    return <View accessibilityLabel="qr" />;
  };
});
jest.mock('expo-camera', () => {
  const { View } = require('react-native');
  return {
    useCameraPermissions: () => [{ granted: false }, jest.fn(() => Promise.resolve({ granted: true }))],
    CameraView: () => <View accessibilityLabel="camera" />,
  };
});
// The pull-to-reveal footer is reanimated + gesture-handler worklets: native
// machinery with no bearing on padding. The screens' own layout stays real.
jest.mock('react-native-reanimated', () => {
  const { View, FlatList } = require('react-native');
  return {
    __esModule: true,
    default: { View, FlatList },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    interpolate: (v: number, inRange: number[], outRange: number[]) =>
      outRange[0] + (v - inRange[0]) * (outRange[1] - outRange[0]),
  };
});
jest.mock('../../feedback/FeedbackProvider', () => ({ useFeedback: () => ({ open: jest.fn() }) }));
jest.mock('../../components/usePullRevealFooter', () => ({
  usePullRevealFooter: () => ({
    pullToReveal: false,
    reveal: { value: 0 },
    gesture: {},
    onScroll: undefined,
    onScrollJS: jest.fn(),
    onScrollViewLayout: jest.fn(),
    onContentSizeChange: jest.fn(),
    footerHeight: 0,
    onFooterLayout: jest.fn(),
  }),
}));
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureDetector: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    GestureHandlerRootView: View,
  };
});

import { auditScreen } from '../edgeInsetAudit';
import ListsHomeScreen from '../../screens/ListsHomeScreen';
import ListDetailScreen from '../../screens/ListDetailScreen';
import KitsHomeScreen from '../../screens/KitsHomeScreen';
import KitDetailScreen from '../../screens/KitDetailScreen';
import ReorderAislesScreen from '../../screens/ReorderAislesScreen';
import ShareScreen from '../../screens/ShareScreen';
import SettingsScreen from '../../screens/SettingsScreen';
import Credits from '../../components/Credits';
import AddItemsSheet from '../../components/AddItemsSheet';
import AddIngredientsSheet from '../../components/AddIngredientsSheet';
import KitPicker from '../../components/KitPicker';
import { useItemEditor } from '../../components/ItemEditor';
import { useActionMenu, usePrompt, useConfirm } from '../../components/Dialogs';
import { LanguageSetting } from '../../components/LanguageSetting';
import { SiriSetting } from '../../components/SiriSetting';
import { Snackbar } from '../../components/Snackbar';
import { SyncStatusBar } from '../../components/SyncStatusBar';
import TipJarSheet from '../../components/TipJarSheet';
import ReviewModal from '../../components/ReviewModal';
import LaunchNoticeModal from '../../components/LaunchNoticeModal';
import { FeedbackSheet } from '../../feedback/FeedbackSheet';
import { TIP_PRODUCT_IDS } from '../../constants/tipProducts';
import { useListsStore } from '../../store/lists';
import { useKitsStore } from '../../store/kits';
import { useAccountStore } from '../../store/account';
import { markConnected, markReceived } from '../../sync/status';
import { makeList, makeItem, type GroceryList } from '../../data/list';
import { makeKit, makeKitItem } from '../../data/kit';
import { starterItemsForLocale } from '../../data/seedCatalog';

/* eslint-disable @typescript-eslint/no-explicit-any */
const navigation = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  replace: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => () => {}),
} as any;
const route = (name: string, params?: object) => ({ key: name, name, params }) as any;
/* eslint-enable @typescript-eslint/no-explicit-any */
const noop = () => {};
const HOUR = 3_600_000;
const SECRET = 'edge-inset-secret';

let shop: GroceryList;
let party: GroceryList;
let kitId = '';
let emptyKitId = '';

beforeEach(() => {
  const now = Date.now();
  shop = makeList('Weekly shop');
  const apples = { ...makeItem('Apples', 'en', 'Produce'), quantity: 3, note: 'The crisp green ones' };
  const leftover = {
    ...makeItem('Eggs', 'en', 'Dairy & eggs'),
    checked: true,
    // Crossed off on a previous shop, so the "clear last shop's leftovers" bar shows.
    checkedAt: now - 8 * HOUR,
  };
  shop.items = [
    makeItem('Bananas', 'en', 'Produce'),
    apples,
    makeItem('Sourdough', 'en', 'Bakery'),
    makeItem('Milk', 'en', 'Dairy & eggs'),
    leftover,
  ];
  // A custom aisle (removable) near the top, where the reorder list draws it.
  shop.categoryOrder = ['Produce', 'Deli', ...shop.categoryOrder.slice(1)];
  shop.shareIdentity = { secret: SECRET, createdAt: now };
  party = makeList('Party');
  party.items = [makeItem('Crisps', 'en', 'Snacks')];
  useListsStore.setState({ lists: [shop, party], hydrated: true });

  const kit = makeKit('Weeknight pasta');
  kit.items = [
    makeKitItem('Spaghetti', 'en', 'Pantry', 2),
    makeKitItem('Passata', 'en', 'Pantry'),
    makeKitItem('Parmesan', 'en', 'Dairy & eggs'),
    makeKitItem('Basil', 'en', 'Produce'),
  ];
  kitId = kit.id;
  // An ingredient straight from the starter catalogue, so the brand-new
  // ingredient picker shows its "In kit" pill.
  const starterKit = makeKit('Breakfast');
  starterKit.items = [makeKitItem(starterItemsForLocale('en')[0].name)];
  emptyKitId = starterKit.id;
  useKitsStore.setState({ kits: [kit, starterKit], hydrated: true });

  useAccountStore.setState({
    hydrated: true,
    staples: ['coffee', 'oat milk'],
    history: [
      { name: 'Coffee', count: 9, lastUsed: now - HOUR },
      { name: 'Oat milk', count: 6, lastUsed: now - 2 * HOUR },
      { name: 'Tomatoes', count: 4, lastUsed: now - 3 * HOUR },
      { name: 'Rice', count: 2, lastUsed: now - 4 * HOUR },
    ],
  });

  markConnected(SECRET, true);
  markReceived(SECRET, now - 3 * HOUR);
});

/** Render, take a step a sheet needs to open (a tap), then audit — the same
 *  canonical helper and metrics `auditScreen` uses. */
function ItemEditorOpen() {
  const editor = useItemEditor();
  useEffect(() => {
    const it = shop.items.find((i) => i.name === 'Apples')!;
    editor.open({ listId: shop.id, itemId: it.id, onRemove: noop });
  }, []);
  return editor.element;
}

function ActionMenuOpen() {
  const menu = useActionMenu();
  useEffect(() => {
    menu.open({
      title: 'Weekly shop',
      options: [
        { label: 'Rename', onPress: noop },
        { label: 'Share this list', onPress: noop },
        { label: 'Delete list', destructive: true, onPress: noop },
      ],
    });
  }, []);
  return menu.element;
}

function PromptOpen() {
  const prompt = usePrompt();
  useEffect(() => {
    prompt.open({
      title: 'Rename list',
      initialValue: 'Weekly shop',
      confirmLabel: 'Save',
      onSubmit: noop,
    });
  }, []);
  return prompt.element;
}

function ConfirmOpen() {
  const confirm = useConfirm();
  useEffect(() => {
    confirm.open({
      title: 'Delete this list?',
      message: 'It goes from this phone and any phone it is shared with.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: noop,
    });
  }, []);
  return confirm.element;
}

describe("edge-inset audit — this app's screens", () => {
  it('Settings', async () => {
    expect(
      await auditScreen(<SettingsScreen navigation={navigation} route={route('Settings')} />, {
        readyText: 'Default list',
      })
    ).toEqual([]);
  });

  it('Lists home', async () => {
    expect(
      await auditScreen(<ListsHomeScreen navigation={navigation} route={route('Lists')} />, {
        readyText: 'Party',
      })
    ).toEqual([]);
  });

  it('List detail (shared, with a leftover from last shop)', async () => {
    expect(
      await auditScreen(
        <ListDetailScreen navigation={navigation} route={route('ListDetail', { listId: shop.id })} />,
        { readyText: 'Sourdough' }
      )
    ).toEqual([]);
  });

  it('Kits home', async () => {
    expect(
      await auditScreen(<KitsHomeScreen navigation={navigation} route={route('Kits')} />, {
        readyText: 'Weeknight pasta',
      })
    ).toEqual([]);
  });

  it('Kit detail', async () => {
    expect(
      await auditScreen(<KitDetailScreen navigation={navigation} route={route('KitDetail', { kitId })} />, {
        readyText: 'Spaghetti',
      })
    ).toEqual([]);
  });

  it('Reorder aisles', async () => {
    expect(
      await auditScreen(
        <ReorderAislesScreen navigation={navigation} route={route('ReorderAisles', { listId: shop.id })} />,
        { readyText: 'Deli' }
      )
    ).toEqual([]);
  });

  it('Share a list', async () => {
    expect(
      await auditScreen(<ShareScreen navigation={navigation} route={route('Share', { listId: shop.id })} />)
    ).toEqual([]);
  });

  it('Acknowledgements', async () => {
    expect(await auditScreen(<Credits onBack={noop} />)).toEqual([]);
  });

  it('Add items sheet (usuals and recent)', async () => {
    expect(
      await auditScreen(<AddItemsSheet visible listId={shop.id} onClose={noop} />, { readyText: 'Tomatoes' })
    ).toEqual([]);
  });

  it('Add items sheet, Kits tab', async () => {
    expect(await auditScreen(<KitPicker listId={shop.id} />, { readyText: 'Weeknight pasta' })).toEqual([]);
  });

  it('Add ingredients sheet (brand new, starter items)', async () => {
    useAccountStore.setState({ staples: [], history: [] });
    expect(
      await auditScreen(<AddIngredientsSheet visible kitId={emptyKitId} onClose={noop} />, {
        readyText: 'In kit',
      })
    ).toEqual([]);
  });

  it('Item editor', async () => {
    expect(await auditScreen(<ItemEditorOpen />, { readyText: 'Edit item' })).toEqual([]);
  });

  it('Action menu', async () => {
    expect(await auditScreen(<ActionMenuOpen />, { readyText: 'Delete list' })).toEqual([]);
  });

  it('Prompt', async () => {
    expect(await auditScreen(<PromptOpen />, { readyText: 'Rename list' })).toEqual([]);
  });

  it('Confirm', async () => {
    expect(await auditScreen(<ConfirmOpen />, { readyText: 'Delete this list?' })).toEqual([]);
  });

  it('Language picker sheet', async () => {
    expect(
      await auditScreen(<LanguageSetting />, {
        interact: async () => {
          await userEvent.setup().press(screen.getByRole('button', { name: /^Language/ }));
          await screen.findByRole('radio', { name: 'Deutsch' });
        },
      })
    ).toEqual([]);
  });

  it('Siri default-list sheet', async () => {
    expect(
      await auditScreen(<SiriSetting />, {
        interact: async () => {
          await userEvent.setup().press(await screen.findByRole('button', { name: /^Default list/ }));
          await screen.findByRole('radio', { name: 'Party' });
        },
      })
    ).toEqual([]);
  });

  it('Snackbar', async () => {
    expect(
      await auditScreen(
        <Snackbar visible message="Crossed off Bananas" actionLabel="Undo" onAction={noop} onDismiss={noop} />
      )
    ).toEqual([]);
  });

  it('Sync status bar', async () => {
    expect(await auditScreen(<SyncStatusBar secret={SECRET} />)).toEqual([]);
  });

  it('Tip jar sheet', async () => {
    expect(
      await auditScreen(<TipJarSheet visible onDismiss={noop} productIds={TIP_PRODUCT_IDS} />)
    ).toEqual([]);
  });

  it('Review prompt', async () => {
    expect(
      await auditScreen(
        <ReviewModal
          visible
          onDismiss={noop}
          appName="Grocery List"
          iosAppStoreId="123"
          androidPackageName="com.joshapproved.grocerylist"
        />
      )
    ).toEqual([]);
  });

  it('Launch notice', async () => {
    expect(await auditScreen(<LaunchNoticeModal visible onDismiss={noop} />)).toEqual([]);
  });

  it('Feedback sheet', async () => {
    expect(await auditScreen(<FeedbackSheet visible onClose={noop} />)).toEqual([]);
  });
});
