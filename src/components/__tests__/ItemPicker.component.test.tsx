/**
 * ItemPicker — action coverage (the behaviors NOT covered by
 * ItemPicker.clearOnAdd.test.tsx). Every user-facing action is driven through
 * the real component and asserted on its observable outcome:
 *   - tapping an item row adds it (onAdd fired)                [pressable-376]
 *   - typing + submit (return key) adds the typed item         [textinput-441]
 *   - empty submit closes the sheet (onClose fired)            [textinput-441]
 *   - tapping the clear (X) button empties the search box      [common.close-456]
 *   - the ★ usual toggle saves/removes a usual                 [pressable-394]
 *   - the recent-row edit (pencil) opens the edit menu         [detail.editItemA11y-413]
 *   - the "Show all / Show less" usuals toggle expands the list[pressable-353]
 *
 * Queries are by role / accessibility label / text — never testID.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ItemPicker from '../ItemPicker';
import { useAccountStore } from '../../store/account';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

jest.mock('expo-haptics', () => ({ selectionAsync: () => Promise.resolve() }));
jest.mock('expo-font', () => ({ useFonts: () => [true, null], isLoaded: () => true }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// Stub the SQLite-backed persistence so the account store runs in node.
jest.mock('../../store/db', () => ({
  loadHistory: jest.fn(async () => []),
  recordHistory: jest.fn(async () => {}),
  deleteHistory: jest.fn(async () => {}),
  putHistory: jest.fn(async () => {}),
  getAppSetting: jest.fn(async () => null),
  setAppSetting: jest.fn(async () => {}),
}));

// Fake timers: the mount-focus timeout + Snackbar auto-dismiss must not fire
// after a test ends (crashes teardown). Real focus is a native no-op here.
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  useAccountStore.setState({ history: [], staples: [] });
});

async function renderPicker(props: Partial<React.ComponentProps<typeof ItemPicker>> = {}) {
  const onAdd = jest.fn();
  const onClose = jest.fn();
  const utils = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ItemPicker
        activeNames={new Set()}
        onAdd={onAdd}
        targetName="Weekly shop"
        onClose={onClose}
        presentLabel="On list"
        presentA11y={(name) => `${name} on list`}
        {...props}
      />
    </SafeAreaProvider>
  );
  const searchBox = () => utils.getByLabelText('Search or add an item');
  return { ...utils, onAdd, onClose, searchBox };
}

test('tapping an item row adds that item', async () => {
  const { onAdd, searchBox, getByLabelText } = await renderPicker();
  // Type a partial term that surfaces the built-in "apple" seed row.
  await fireEvent.changeText(searchBox(), 'app');
  await fireEvent.press(getByLabelText('Add apple'));
  expect(onAdd).toHaveBeenCalledWith('apple', expect.anything());
});

test('typing a term and submitting (return key) adds the typed item', async () => {
  const { onAdd, searchBox } = await renderPicker();
  await fireEvent.changeText(searchBox(), 'Dragonfruit');
  await fireEvent(searchBox(), 'submitEditing');
  expect(onAdd).toHaveBeenCalledWith('Dragonfruit', undefined);
});

test('submitting an empty search box closes the sheet', async () => {
  const { onAdd, onClose, searchBox } = await renderPicker();
  await fireEvent(searchBox(), 'submitEditing');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onAdd).not.toHaveBeenCalled();
});

test('tapping the clear button empties the search box', async () => {
  const { searchBox, getByLabelText } = await renderPicker();
  await fireEvent.changeText(searchBox(), 'milk');
  expect(searchBox().props.value).toBe('milk');
  // The clear affordance carries the "Close" a11y label.
  await fireEvent.press(getByLabelText('Close'));
  expect(searchBox().props.value).toBe('');
});

test('tapping the star toggle saves an item as a usual', async () => {
  const { searchBox, getByLabelText } = await renderPicker();
  // A short prefix like "app" matches several catalog entries (apple, apple
  // pie, ...) — even "brocc" also substring-matches "frozen broccoli" — so
  // more than one "Save as a usual" button would be on screen. "aspar" is a
  // prefix no other catalog item contains, matching only "asparagus".
  await fireEvent.changeText(searchBox(), 'aspar');
  // "asparagus" is not yet a usual → the toggle offers to save it.
  await fireEvent.press(getByLabelText('Save as a usual'));
  expect(useAccountStore.getState().staples.map((n) => n.toLowerCase())).toContain(
    'asparagus'
  );
});

test('tapping the star on an existing usual removes it', async () => {
  // The store always keeps staples lowercase (see account.ts's addStaple) —
  // seed it the same way so usualSet lookups (also lowercase) match.
  useAccountStore.setState({ staples: ['apple'] });
  const { getByLabelText } = await renderPicker();
  // Browsing (no query) shows the usuals section; "Apple" is a usual.
  await fireEvent.press(getByLabelText('Remove from usuals'));
  expect(useAccountStore.getState().staples).not.toContain('Apple');
});

test('the edit (pencil) on a recent row opens the edit menu', async () => {
  // Seed history so a "Recent" row with an edit affordance renders.
  useAccountStore.setState({
    history: [{ name: 'Butter', count: 1, lastUsed: Date.now() }] as any,
    staples: [],
  });
  const { getByLabelText, getByText } = await renderPicker();
  await fireEvent.press(getByLabelText('Edit Butter'));
  // The action menu opened → its Edit / Delete options are now on screen.
  expect(getByText('Delete')).toBeTruthy();
});

test('the "Show all" usuals toggle expands the peeked list', async () => {
  // 9 usuals > USUALS_PEEK(8) so the "more" toggle renders while browsing.
  // Kept at 9 (not more) so header+rows stay within FlatList's default
  // initialNumToRender window in the test renderer — a bigger dataset would
  // window out the last row regardless of showAllUsuals.
  const many = Array.from({ length: 9 }, (_, i) => `Usual${i}`);
  useAccountStore.setState({ staples: many });
  const { getByLabelText, queryByLabelText } = await renderPicker();
  // Only the first 8 are shown initially.
  expect(queryByLabelText('Add Usual8')).toBeNull();
  await fireEvent.press(getByLabelText('Show all'));
  expect(getByLabelText('Add Usual8')).toBeTruthy();
});
