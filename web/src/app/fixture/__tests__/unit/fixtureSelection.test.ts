import { describe, expect, it } from 'vitest';
import { FIXTURE_SELECTED_ID } from '../../fixtureData';
import { fixtureSelectedId } from '../../fixtureSelection';

describe('fixtureSelectedId', () => {
  it('keeps the canonical route selected, so the goldens do not move', () => {
    expect(fixtureSelectedId('')).toBe(FIXTURE_SELECTED_ID);
    expect(fixtureSelectedId('?stale=macbook')).toBe(FIXTURE_SELECTED_ID);
    expect(fixtureSelectedId('?selection=')).toBe(FIXTURE_SELECTED_ID);
  });

  it('expresses no selection for the no-Session home (#1082)', () => {
    expect(fixtureSelectedId('?selection=none')).toBeNull();
    expect(fixtureSelectedId('?stale=macbook&selection=none')).toBeNull();
  });

  it('treats an unrecognised value as the canonical route', () => {
    // Only `none` has a meaning. A route that could name an arbitrary Session
    // would let a test assert a selection the product never made — and there is
    // no second Session in the fixtures worth naming anyway.
    expect(fixtureSelectedId('?selection=devbox-01:design-system')).toBe(
      FIXTURE_SELECTED_ID,
    );
    expect(fixtureSelectedId('?selection=nonee')).toBe(FIXTURE_SELECTED_ID);
  });
});
