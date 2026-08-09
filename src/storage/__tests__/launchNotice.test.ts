/**
 * Trust-core tests for the launch-notice trigger.
 *
 * The two things that can go wrong in production are both silent: a notice
 * that never stops (annoys every user of a mature app) and a notice that
 * never starts (the launch window quietly does nothing). Both stops are
 * asserted here, plus the malformed-date fail-closed path.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  LAUNCH_NOTICE_CONFIG,
  isWithinLaunchWindow,
  markLaunchNoticeShown,
  resetLaunchNotice,
  shouldShowLaunchNotice,
} from '../launchNotice';

const DAY_MS = 24 * 60 * 60 * 1000;
const LAUNCHED = '2026-07-27';
const LAUNCH_MS = Date.parse(LAUNCHED);

/** now() at `days` after launch. */
const at = (days: number) => LAUNCH_MS + days * DAY_MS;

beforeEach(async () => {
  await AsyncStorage.clear();
  await resetLaunchNotice();
});

describe('isWithinLaunchWindow', () => {
  it('is open on launch day and just inside the window', () => {
    expect(isWithinLaunchWindow(LAUNCHED, at(0))).toBe(true);
    expect(
      isWithinLaunchWindow(LAUNCHED, at(LAUNCH_NOTICE_CONFIG.windowDays - 1))
    ).toBe(true);
  });

  it('closes once the window elapses, and stays closed', () => {
    expect(
      isWithinLaunchWindow(LAUNCHED, at(LAUNCH_NOTICE_CONFIG.windowDays))
    ).toBe(false);
    expect(isWithinLaunchWindow(LAUNCHED, at(365))).toBe(false);
  });

  it('fails closed on a malformed or missing date', () => {
    expect(isWithinLaunchWindow('not-a-date', at(1))).toBe(false);
    expect(isWithinLaunchWindow('', at(1))).toBe(false);
  });

  it('fails closed before the launch date (clock skew / future date)', () => {
    expect(isWithinLaunchWindow(LAUNCHED, at(-1))).toBe(false);
  });
});

describe('shouldShowLaunchNotice', () => {
  it('shows for exactly maxShowings sessions, then never again', async () => {
    for (let i = 0; i < LAUNCH_NOTICE_CONFIG.maxShowings; i += 1) {
      expect(await shouldShowLaunchNotice(LAUNCHED, undefined, at(1))).toBe(
        true
      );
      await markLaunchNoticeShown();
    }
    expect(await shouldShowLaunchNotice(LAUNCHED, undefined, at(1))).toBe(
      false
    );
    // Still capped much later in the window.
    expect(await shouldShowLaunchNotice(LAUNCHED, undefined, at(30))).toBe(
      false
    );
  });

  it('stops at the window even with showings left', async () => {
    await markLaunchNoticeShown(); // 1 of 3 used
    expect(await shouldShowLaunchNotice(LAUNCHED, undefined, at(59))).toBe(
      true
    );
    expect(await shouldShowLaunchNotice(LAUNCHED, undefined, at(61))).toBe(
      false
    );
  });

  it('never shows for an app whose window closed before install', async () => {
    expect(await shouldShowLaunchNotice(LAUNCHED, undefined, at(200))).toBe(
      false
    );
  });

  it('keeps separate counts per storage key', async () => {
    await markLaunchNoticeShown('@app/a');
    await markLaunchNoticeShown('@app/a');
    await markLaunchNoticeShown('@app/a');
    expect(await shouldShowLaunchNotice(LAUNCHED, '@app/a', at(1))).toBe(false);
    expect(await shouldShowLaunchNotice(LAUNCHED, '@app/b', at(1))).toBe(true);
  });
});
