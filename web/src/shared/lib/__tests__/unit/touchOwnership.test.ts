import { describe, expect, it, vi } from 'vitest';
import {
  claimTouchOwnership,
  isTouchOwned,
  releaseAllTouchOwnership,
  subscribeTouchOwnership,
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

  it('notifies subscribers when a finger is claimed (#2724)', () => {
    // A consumer that has already started a gesture must be able to stand down
    // even when the new owner consumes the following events before they reach
    // it — ordering is not authority.
    const listener = vi.fn();
    const unsubscribe = subscribeTouchOwnership(listener);

    const release = claimTouchOwnership(4, 'terminal-direction-pad');

    expect(listener).toHaveBeenCalledWith(4, 'terminal-direction-pad');

    unsubscribe();
    release();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTouchOwnership(listener);
    unsubscribe();

    const release = claimTouchOwnership(5, 'terminal-direction-pad');
    expect(listener).not.toHaveBeenCalled();
    release();
  });
});
