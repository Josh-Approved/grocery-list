/**
 * Component test — TipJarSheet (Uplevel-3 T3 action coverage).
 *
 * Three user actions across the sheet's states:
 *   • A tier button (status "ready") → fires onTip(sku) with the product id.
 *   • "Maybe later" (any non-thanks state) → fires onDismiss.
 *   • "Done" (status "thanks") → fires onDismiss.
 * We control the IAP state by mocking `../lib/tipJar` (the native billing hook),
 * never the component under test. Prices come from the mocked product's
 * displayPrice, matching the real "never hardcode a price" contract. Queries by
 * role/label only; no testID, no snapshots.
 */

import React from 'react';
import { render, screen, userEvent } from '@testing-library/react-native';

jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Controllable IAP hook — set by each test before render.
const tipMock = jest.fn();
let tipState: {
  status: string;
  products: { id: string; displayPrice: string }[];
  pendingSku: string | null;
};
jest.mock('../../lib/tipJar', () => ({
  isStoreKnownUnavailable: () => false,
  useTipJar: () => ({ ...tipState, tip: tipMock }),
}));

import TipJarSheet from '../TipJarSheet';

const PRODUCT_IDS = ['tip.small', 'tip.medium'] as const;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TipJarSheet', () => {
  it('fires onTip with the product id when a tier is pressed', async () => {
    tipState = {
      status: 'ready',
      products: [
        { id: 'tip.small', displayPrice: '$1.99' },
        { id: 'tip.medium', displayPrice: '$4.99' },
      ],
      pendingSku: null,
    };
    const user = userEvent.setup();

    await render(
      <TipJarSheet visible onDismiss={jest.fn()} productIds={PRODUCT_IDS} />
    );

    // Tiers are buttons labelled "Tip <price>".
    await user.press(screen.getByRole('button', { name: 'Tip $4.99' }));
    expect(tipMock).toHaveBeenCalledWith('tip.medium');
  });

  it('dismisses when Maybe later is pressed', async () => {
    tipState = { status: 'ready', products: [], pendingSku: null };
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(
      <TipJarSheet visible onDismiss={onDismiss} productIds={PRODUCT_IDS} />
    );

    await user.press(screen.getByRole('button', { name: 'Maybe later' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses when Done is pressed in the thank-you state', async () => {
    tipState = { status: 'thanks', products: [], pendingSku: null };
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(
      <TipJarSheet visible onDismiss={onDismiss} productIds={PRODUCT_IDS} />
    );

    await user.press(screen.getByRole('button', { name: 'Done' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
