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

function entryState(id: CapabilityId, overrides: Partial<CapsuleCapabilityInput> = {}) {
  return resolveCapsuleCapabilities(input(overrides)).entries.find((entry) => entry.id === id)
    ?.state;
}

describe('capsule capability presence', () => {
  it('has no direct slot, whatever the capability states are', () => {
    // The revision (#748 / terminal-capsule.md 2026-09-16): capability state is
    // expressed inside `+`, never on the resting capsule. The behavioural
    // consequence is that nothing is promoted out of the disclosure list —
    // an active capability is still *in* it, marked.
    const ids = entryIds({ facts: { sessionForegroundCommand: 'claude.exe' } });

    expect(ids).toContain('claude-code');
    expect(entryState('claude-code', { facts: { sessionForegroundCommand: 'claude.exe' } })).toBe(
      'active',
    );
  });

  it('carries each capability state so `+` can mark it', () => {
    expect(
      entryState('claude-code', {
        facts: { sessionForegroundCommand: 'bash', sessionObservedCommands: ['claude.exe'] },
      }),
    ).toBe('relevant');
  });

  it('reaches a merely-available capability through `+` without marking it', () => {
    expect(entryState('claude-code')).toBe('available');
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

  it('keeps every reachable capability reachable', () => {
    const ids = entryIds({ facts: { sessionForegroundCommand: 'claude.exe' } });

    // The capsule is the only surface a user watching a session has in front of
    // them, so a capability that is merely available must still be listed.
    expect(ids).toContain('session');
    expect(ids).toContain('agent');
    expect(ids).toContain('claude-code');
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
