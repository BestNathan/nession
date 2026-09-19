import { describe, expect, it } from 'vitest';
import {
  resolveCapabilityProjection,
  type EmergenceInput,
} from '@/product/capability/emergence';
import { resolveCapabilityPresences } from '@/product/capability/presence';
import type { CapabilityId, CapabilitySnapshot, CapabilityState } from '@/product/capability/model';

function snapshot(id: CapabilityId, state: CapabilityState): CapabilitySnapshot {
  return { id, title: id, scope: {}, state };
}

type EmergenceOverrides = Partial<Pick<EmergenceInput, 'chosen' | 'opened' | 'dismissed' | 'projectable'>>;

/**
 * Resolve through the real presence policy rather than hand-writing levels, so
 * a change to that policy reaches these assertions instead of being masked by
 * fixtures that agreed with the old one.
 */
function resolve(snapshots: CapabilitySnapshot[], input: EmergenceOverrides = {}) {
  return resolveCapabilityProjection({
    snapshots,
    presences: resolveCapabilityPresences(snapshots, { surface: 'capsule' }),
    // Every id these fixtures use is treated as drawable unless a case says
    // otherwise, so the rule under test is the one being asserted.
    projectable: snapshots.map((snapshot) => snapshot.id),
    ...input,
  });
}

describe('nothing emerges on its own (Q1)', () => {
  it('is dormant when nothing was chosen and nothing is running', () => {
    // The whole point of the v1 answer: no relevance threshold, no decay timer.
    // `available` and `relevant` stay in the capability entry.
    const snapshots = [snapshot('files', 'available'), snapshot('git', 'relevant')];

    expect(resolve(snapshots)).toBeUndefined();
  });

  it('emerges the capability the Session is observed running', () => {
    // The one automatic path, and the one that already existed: the pane is
    // running it right now.
    const snapshots = [snapshot('git', 'available'), snapshot('claude-code', 'active')];

    expect(resolve(snapshots)).toEqual({ capabilityId: 'claude-code', depth: 'signal' });
  });

  it('never emerges a capability that cannot be drawn', () => {
    // The bug this rule exists for: a capability with no Terminal projection
    // would be selected into a depth nothing renders, and vanish silently.
    const snapshots = [snapshot('claude-code', 'active')];

    expect(resolve(snapshots, { projectable: [] })).toBeUndefined();
    // And one that merely cannot be *drawn* is not the same as one that cannot
    // be *seen*: it stays reachable through the capability entry.
    expect(resolve(snapshots, { chosen: 'claude-code', projectable: [] })).toBeUndefined();
  });

  it('never emerges an unavailable capability', () => {
    // `unavailable` resolves to `hidden`, which is absence rather than a
    // disabled slot — `workspace-navigation.md`'s anti-pattern.
    expect(resolve([snapshot('git', 'unavailable')])).toBeUndefined();
  });
});

describe('one at a time, deterministically (Q2)', () => {
  it('prefers the chosen capability over one that is merely running', () => {
    const snapshots = [snapshot('claude-code', 'active'), snapshot('git', 'available')];

    expect(resolve(snapshots, { chosen: 'git' })).toEqual({
      capabilityId: 'git',
      depth: 'signal',
    });
  });

  it('breaks a tie by registration order, not by a priority number', () => {
    const snapshots = [snapshot('a', 'active'), snapshot('b', 'active')];

    expect(resolve(snapshots)?.capabilityId).toBe('a');
  });

  it('opens the chosen capability to peek, and back again', () => {
    const snapshots = [snapshot('git', 'available')];

    expect(resolve(snapshots, { chosen: 'git', opened: true })).toEqual({
      capabilityId: 'git',
      depth: 'peek',
    });
    expect(resolve(snapshots, { chosen: 'git', opened: false })?.depth).toBe('signal');
  });

  it('ignores a choice that is no longer reachable', () => {
    // Choosing something and then having it become unavailable must not leave a
    // projection for a capability the registry has since hidden.
    expect(resolve([snapshot('git', 'unavailable')], { chosen: 'git' })).toBeUndefined();
  });
});

describe('a dismissal stays dismissed (Q3)', () => {
  it('does not re-emerge what the user closed', () => {
    // Without this the observed-command path re-emerges on the next render and
    // the dismissal silently undoes itself.
    const snapshots = [snapshot('claude-code', 'active')];

    expect(resolve(snapshots, { dismissed: ['claude-code'] })).toBeUndefined();
  });

  it('re-emerges it when chosen again', () => {
    // That is how the entry undoes a dismissal — otherwise a closed Signal
    // would be unreachable until the session changed.
    const snapshots = [snapshot('claude-code', 'active')];

    expect(resolve(snapshots, { chosen: 'claude-code', dismissed: ['claude-code'] })?.capabilityId).toBe(
      'claude-code',
    );
  });

  it('leaves a different capability free to emerge', () => {
    const snapshots = [snapshot('claude-code', 'active'), snapshot('git', 'active')];

    expect(resolve(snapshots, { dismissed: ['claude-code'] })?.capabilityId).toBe('git');
  });
});
