import { describe, expect, it } from 'vitest';
import {
  claimTouchOwnership,
  isTouchOwned,
  releaseAllTouchOwnership,
} from '../../touchOwnership';

describe('touch ownership registry', () => {
  it('lets a surface claim one finger without touching the others', () => {
    const release = claimTouchOwnership(7, 'terminal-direction-pad');

    expect(isTouchOwned(7)).toBe(true);
    expect(isTouchOwned(8)).toBe(false);

    release();
    expect(isTouchOwned(7)).toBe(false);
  });

  it('does not let a stale release clear a newer claim for the same finger id', () => {
    const first = claimTouchOwnership(3, 'terminal-direction-pad');
    const second = claimTouchOwnership(3, 'terminal-direction-pad');

    first();
    expect(isTouchOwned(3)).toBe(true);

    second();
    expect(isTouchOwned(3)).toBe(false);
  });

  it('clears every claim when the page loses its touch sequence', () => {
    claimTouchOwnership(1, 'one');
    claimTouchOwnership(2, 'two');

    releaseAllTouchOwnership();

    expect(isTouchOwned(1)).toBe(false);
    expect(isTouchOwned(2)).toBe(false);
  });
});
