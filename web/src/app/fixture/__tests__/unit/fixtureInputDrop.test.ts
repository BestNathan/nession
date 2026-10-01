import { describe, expect, it } from 'vitest';
import { fixtureInputDrop } from '../../fixtureInputDrop';

describe('fixtureInputDrop', () => {
  it('is null when the route names no drop', () => {
    // Absent means "nothing was lost", which is the canonical route the golden
    // screenshots capture — so the default must not be a drop, or the notice
    // would draw in every baseline.
    expect(fixtureInputDrop('')).toBeNull();
    expect(fixtureInputDrop('?stale=macbook')).toBeNull();
  });

  it('reads each reason the product can produce', () => {
    // The four members of `InputDropReason`, one case each: the notice has a
    // sentence per reason and a reason with no route cannot be photographed.
    expect(fixtureInputDrop('?drop=epoch')?.reason).toBe('epoch');
    expect(fixtureInputDrop('?drop=age')?.reason).toBe('age');
    expect(fixtureInputDrop('?drop=bound')?.reason).toBe('bound');
    expect(fixtureInputDrop('?drop=generation')?.reason).toBe('generation');
  });

  it('drops a reason the product cannot produce', () => {
    // The parameter is user-typeable, and `InputDropReason` is a closed union —
    // `inputDropNotice` has no branch for anything else, so a value let through
    // here renders the strip with an empty sentence. That is a state no Session
    // can be in, which is the same rule `fixtureStaleAgents` applies to an id
    // naming no Agent.
    expect(fixtureInputDrop('?drop=nonsense')).toBeNull();
    expect(fixtureInputDrop('?drop=EPOCH')).toBeNull();
  });

  it('treats an empty parameter as no drop rather than as one', () => {
    // `?drop=` is what a URL looks like after a value is cleared. It must not
    // reach the surface as a reason, and `''` is not one.
    expect(fixtureInputDrop('?drop=')).toBeNull();
  });
});
