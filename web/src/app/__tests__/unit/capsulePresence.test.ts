import { describe, expect, it, vi } from 'vitest';
import type { CapabilityId, CapabilitySnapshot, CapabilityState } from '@/product/capability';
import type { Session } from '@/types';
import { resolveCapsuleCapabilities, type CapsuleCapabilityInput } from '../../capsulePresence';

function snapshot(id: CapabilityId, state: CapabilityState): CapabilitySnapshot {
  return { id, title: id, scope: {}, state };
}

void snapshot;

function input(overrides: Partial<CapsuleCapabilityInput> = {}): CapsuleCapabilityInput {
  return {
    session: { session_id: 's1', session_name: 'work', agent_id: 'a1' } as Session,
    agent: undefined,
    agents: [],
    domain: null,
    fileOps: null,
    experience: 'web',
    facts: undefined,
    onToolChange: vi.fn(),
    onSurfaceChange: vi.fn(),
    onOpenWorkspace: vi.fn(),
    ...overrides,
  };
}

function entryIds(overrides: Partial<CapsuleCapabilityInput> = {}): CapabilityId[] {
  return resolveCapsuleCapabilities(input(overrides)).entries.map((entry) => entry.id);
}

describe('capsule capability presence', () => {
  // ── What the entry may offer (#1046) ────────────────────────────────────
  //
  // Capsule eligibility is a statement about the **Terminal**: the entry lists
  // what can be peeked at from where the user already is. Having a Workspace
  // view is not enough — the entry is not a shortcut into the Workspace, and it
  // is not a list of everything that exists.

  it('lists a capability that contributes a Peek', () => {
    // Git is the reference: a changed-file summary is worth a Terminal depth,
    // and that is the only thing that earns explicit discovery.
    expect(entryIds()).toContain('git');
  });

  it('does not list a Workspace-only capability', () => {
    // Files has a Workspace view and no Terminal projection. Selecting it from the
    // capsule used to switch surface, which is what #1046 removes — and the
    // removal is at the source, so it is not offered at all rather than offered
    // and ignored.
    const ids = entryIds();

    expect(ids).not.toContain('files');
    expect(ids).not.toContain('env');
  });

  it('lists Claude Code now that it contributes a real Peek (#1120)', () => {
    // This asserted the opposite until #1120, and said how it would end: "It
    // returns to the entry when the plugin contributes a real Peek." The plugin
    // now does, so the instance changed. The rule it used to be checked against
    // — a `'signal'` binding earns no discovery — went with the depth axis:
    // `CAPSULE_PROJECTION_IDS` is one list now, so there is no second answer
    // left for a loop to compare it against.
    expect(entryIds({ facts: { sessionForegroundCommand: 'claude.exe' } })).toContain(
      'claude-code',
    );
  });

  it('keeps the built-in Terminal-local Peek listed', () => {
    // The other side of the rule, and the reason eligibility is a declared role
    // rather than "has a Peek contribution" alone: Terminal Keys is not a
    // Workspace capability and has no Workspace view to be confused with. The
    // requirement's own edge case keeps it — a node whose only Peek-capable
    // capability is unavailable should not present an empty menu.
    expect(entryIds()).toContain('terminal-keys');
  });

  it('never offers a hidden capability for discovery', () => {
    // `files` needs file ops, so without them it is unavailable — hidden, not
    // disclosed. Absent means absent, not "one more click away".
    expect(entryIds({ fileOps: null })).not.toContain('files');
  });

  it('offers nothing at all when the catalog is empty', () => {
    // No session ⇒ claude-code has no scope; and with no file ops `files` is
    // hidden. An empty resolution is what the contribution turns into no popover
    // at all, rather than an empty one.
    expect(entryIds({ session: null, fileOps: null })).not.toContain('claude-code');
  });

  it('resolves a capability state independently of the entry list', () => {
    // The projection reads lifecycle from `snapshots`, not from the entry list,
    // and #1046 does not change that: it still emerges by observation when its
    // state warrants it. The entry half of this assertion is gone because its
    // subject is: after #1120 all three projections are listed, so there is no
    // unlisted capability left to make the point through. What the capsule
    // actually reads is the snapshot, which is where it belongs anyway.
    const facts = { sessionForegroundCommand: 'claude.exe' };
    const resolution = resolveCapsuleCapabilities(input({ facts }));

    expect(resolution.snapshots.find((s) => s.id === 'claude-code')?.state).toBe('active');
  });

  it('names a capability from the registry, never from the view', () => {
    // Chrome reads the title the capability layer resolved, so a view binding
    // cannot invent one — the same rule the Workspace shell follows for an
    // unavailable-state title.
    const resolution = resolveCapsuleCapabilities(input());

    expect(resolution.titleFor('git')).toBe('Git');
    // A capability nobody registered is not given a name it did not claim.
    expect(resolution.titleFor('nobody-registered-this')).toBe('nobody-registered-this');
  });

  it('exposes the resolved snapshots the projection reads', () => {
    // The projection is resolved from the same answer as the discovery list, so
    // a capability cannot be active for one and absent for the other.
    const resolution = resolveCapsuleCapabilities(
      input({ facts: { sessionForegroundCommand: 'claude.exe' } }),
    );

    expect(resolution.snapshots.find((s) => s.id === 'claude-code')?.state).toBe('active');
  });
});
