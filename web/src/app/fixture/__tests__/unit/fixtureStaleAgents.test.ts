import { describe, expect, it } from 'vitest';
import { fixtureStaleAgents } from '../../fixtureStaleAgents';

describe('fixtureStaleAgents', () => {
  it('is empty when the route names no Agent', () => {
    // Absent means "nothing failed to answer", which is the canonical route the
    // golden screenshots capture — so the default must not be a non-empty list.
    expect(fixtureStaleAgents('')).toEqual([]);
    expect(fixtureStaleAgents('?capability=git')).toEqual([]);
  });

  it('reads the Agents the route names', () => {
    expect(fixtureStaleAgents('?stale=macbook')).toEqual(['macbook']);
    expect(fixtureStaleAgents('?stale=macbook,devbox-01')).toEqual([
      'macbook',
      'devbox-01',
    ]);
  });

  it('drops ids that name no fixture Agent', () => {
    // The Server reports staleness for Agents it knows, so an id naming none is
    // not an input the product can be handed: letting one through would put a
    // Session into a state nothing else on the screen explains.
    expect(fixtureStaleAgents('?stale=ghost-host')).toEqual([]);
    expect(fixtureStaleAgents('?stale=ghost-host,macbook')).toEqual(['macbook']);
  });

  it('tolerates the spacing a hand-written URL arrives with', () => {
    expect(fixtureStaleAgents('?stale=macbook, devbox-01')).toEqual([
      'macbook',
      'devbox-01',
    ]);
  });

  it('treats an empty parameter as no Agent rather than as one', () => {
    // `?stale=` is what a URL looks like after a value is cleared; it must not
    // reach `mapDomainState` as the empty id, which would match no Agent
    // anyway but would make the list non-empty and the parameter look honoured.
    expect(fixtureStaleAgents('?stale=')).toEqual([]);
  });
});
