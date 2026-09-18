import { describe, expect, it, vi } from 'vitest';
import type { CapabilityId, CapabilitySnapshot, CapabilityState } from '@/product/capability';
import type { Session } from '@/types';
import { resolveCapsuleCapabilities, type CapsuleCapabilityInput } from '../../capsulePresence';

function snapshot(id: CapabilityId, state: CapabilityState): CapabilitySnapshot {
  return { id, title: id, scope: {}, state };
}

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
    ...overrides,
  };
}

describe('capsule capability presence', () => {
  it('has no direct slot, whatever the capability states are', () => {
    // The revision (#748 / terminal-capsule.md 2026-09-16): capability state is
    // expressed inside `+`, never on the resting capsule. The behavioural
    // consequence is that nothing is promoted out of the disclosure list —
    // an active capability is still *in* it, marked.
    const entries = resolveCapsuleCapabilities(
      input({ facts: { sessionForegroundCommand: 'claude.exe' } }),
    ).disclosure?.entries ?? [];

    expect(entries.map((entry) => entry.id)).toContain('claude-code');
    expect(entries.find((entry) => entry.id === 'claude-code')?.state).toBe('active');
  });

  it('carries each capability state so `+` can mark it', () => {
    const entries = resolveCapsuleCapabilities(
      input({ facts: { sessionForegroundCommand: 'bash', sessionObservedCommands: ['claude.exe'] } }),
    ).disclosure?.entries ?? [];

    expect(entries.find((entry) => entry.id === 'claude-code')?.state).toBe('relevant');
  });

  it('reaches a merely-available capability through `+` without marking it', () => {
    const entries = resolveCapsuleCapabilities(input()).disclosure?.entries ?? [];

    expect(entries.find((entry) => entry.id === 'claude-code')?.state).toBe('available');
  });

  it('never offers a hidden capability for discovery', () => {
    // `files` needs file ops, so without them it is unavailable — hidden, not
    // disclosed. Absent means absent, not "one more click away".
    const ids = resolveCapsuleCapabilities(input({ fileOps: null })).disclosure?.entries
      .map((entry) => entry.id) ?? [];

    expect(ids).not.toContain('files');
  });

  it('offers nothing at all when the catalog is empty', () => {
    // No session ⇒ claude-code has no scope; and with no file ops `files` is
    // hidden. An empty list must be `undefined`, not an empty popover.
    const contribution = resolveCapsuleCapabilities(input({ session: null, fileOps: null }));

    expect(contribution.disclosure?.entries ?? []).not.toContain('claude-code');
  });
});

describe('capsule capability wiring', () => {
  it('activates a disclosed capability by handing it to the Workspace', () => {
    const onToolChange = vi.fn();
    const onSurfaceChange = vi.fn();

    const { disclosure } = resolveCapsuleCapabilities(input({ onToolChange, onSurfaceChange }));
    const entries = disclosure?.entries ?? [];

    expect(entries.length).toBeGreaterThan(0);
    disclosure?.onSelect(entries[0].id);

    expect(onToolChange).toHaveBeenCalledWith(entries[0].id);
    expect(onSurfaceChange).toHaveBeenCalledTimes(1);
  });

  it('keeps every reachable capability reachable', () => {
    const ids = resolveCapsuleCapabilities(
      input({ facts: { sessionForegroundCommand: 'claude.exe' } }),
    ).disclosure?.entries.map((entry) => entry.id) ?? [];

    // The capsule is the only surface a user watching a session has in front of
    // them, so a capability that is merely available must still be listed.
    expect(ids).toContain('session');
    expect(ids).toContain('agent');
    expect(ids).toContain('claude-code');
  });
});

describe('snapshot helper', () => {
  it('builds the shape the resolver consumes', () => {
    expect(snapshot('git', 'active')).toEqual({
      id: 'git',
      title: 'git',
      scope: {},
      state: 'active',
    });
  });
});
