import { planDrain, resolveTargetListId } from '../drain';
import type { PendingSiriItem, SiriListRef } from '../native';

const lists: SiriListRef[] = [
  { id: 'l_home', name: 'Home' },
  { id: 'l_cabin', name: 'Cabin' },
];

function pending(overrides: Partial<PendingSiriItem>): PendingSiriItem {
  return {
    requestId: 'r1',
    listId: 'l_home',
    name: 'milk',
    addedAt: 1000,
    ...overrides,
  };
}

describe('resolveTargetListId', () => {
  it('keeps the stamped list when it still exists', () => {
    expect(resolveTargetListId({ listId: 'l_cabin' }, lists, 'l_home')).toBe(
      'l_cabin'
    );
  });

  it('falls back to the default when the stamped list is gone', () => {
    expect(resolveTargetListId({ listId: 'l_deleted' }, lists, 'l_home')).toBe(
      'l_home'
    );
  });

  it('ignores a default that no longer exists', () => {
    expect(
      resolveTargetListId({ listId: 'l_deleted' }, lists, 'l_also_gone')
    ).toBeNull();
  });

  it('uses the only list when there is exactly one and nothing else resolves', () => {
    const one = [{ id: 'l_only', name: 'Groceries' }];
    expect(resolveTargetListId({ listId: null }, one, null)).toBe('l_only');
  });

  it('refuses to guess among several lists with no stamp and no default', () => {
    expect(resolveTargetListId({ listId: null }, lists, null)).toBeNull();
  });
});

describe('planDrain', () => {
  it('plans one add per resolvable item and drains every request id', () => {
    const plan = planDrain(
      [
        pending({ requestId: 'r1', name: 'milk', listId: 'l_home' }),
        pending({ requestId: 'r2', name: 'eggs', listId: 'l_cabin' }),
      ],
      lists,
      'l_home'
    );
    expect(plan.adds).toEqual([
      { listId: 'l_home', name: 'milk' },
      { listId: 'l_cabin', name: 'eggs' },
    ]);
    expect(plan.drainedRequestIds).toEqual(['r1', 'r2']);
  });

  it('de-dupes the same item + list within one batch', () => {
    const plan = planDrain(
      [
        pending({ requestId: 'r1', name: 'Milk', listId: 'l_home' }),
        pending({ requestId: 'r2', name: 'milk', listId: 'l_home' }),
      ],
      lists,
      null
    );
    expect(plan.adds).toEqual([{ listId: 'l_home', name: 'Milk' }]);
    // still drains both so neither re-processes next launch
    expect(plan.drainedRequestIds).toEqual(['r1', 'r2']);
  });

  it('keeps the same item on two different lists', () => {
    const plan = planDrain(
      [
        pending({ requestId: 'r1', name: 'milk', listId: 'l_home' }),
        pending({ requestId: 'r2', name: 'milk', listId: 'l_cabin' }),
      ],
      lists,
      null
    );
    expect(plan.adds).toHaveLength(2);
  });

  it('drains but does not add an unresolvable item', () => {
    const plan = planDrain(
      [pending({ requestId: 'r1', name: 'milk', listId: 'l_gone' })],
      lists,
      null // no default, >1 list -> cannot resolve
    );
    expect(plan.adds).toEqual([]);
    expect(plan.drainedRequestIds).toEqual(['r1']);
  });

  it('skips (but drains) blank names', () => {
    const plan = planDrain(
      [pending({ requestId: 'r1', name: '   ', listId: 'l_home' })],
      lists,
      'l_home'
    );
    expect(plan.adds).toEqual([]);
    expect(plan.drainedRequestIds).toEqual(['r1']);
  });
});
