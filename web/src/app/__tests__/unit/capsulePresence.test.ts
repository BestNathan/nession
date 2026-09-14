import { describe, expect, it, vi } from 'vitest';
import type { CapabilityId, CapabilitySnapshot, CapabilityState } from '@/features/capabilities';
import type { Session } from '@/types';
import {
  resolveCapsuleCapabilities,
  selectCapsuleCapability,
  type CapsuleCapabilityInput,
} from '../../capsulePresence';

function snapshot(id: CapabilityId, state: CapabilityState): CapabilitySnapshot {
  return { id, title: id, scope: {}, state };
}

describe('capsule capability presence', () => {
  it('gives no presence to a capability that is merely available', () => {
    expect(selectCapsuleCapability([snapshot('claude-code', 'available')])).toBeUndefined();
  });

  it('gives no presence to an unavailable capability', () => {
    expect(selectCapsuleCapability([snapshot('claude-code', 'unavailable')])).toBeUndefined();
  });

  it('lets a relevant capability appear', () => {
    expect(selectCapsuleCapability([snapshot('claude-code', 'relevant')])?.id).toBe('claude-code');
  });

  it('lets an active capability appear', () => {
    expect(selectCapsuleCapability([snapshot('claude-code', 'active')])?.id).toBe('claude-code');
  });

  it('prefers the active capability over a relevant one', () => {
    const selected = selectCapsuleCapability([
      snapshot('claude-code', 'relevant'),
      snapshot('docker', 'active'),
    ]);

    expect(selected?.id).toBe('docker');
    expect(selected?.state).toBe('active');
  });

  it('keeps the capsule bounded — one capsule, one capability', () => {
    const selected = selectCapsuleCapability([
      snapshot('claude-code', 'relevant'),
      snapshot('docker', 'active'),
      snapshot('git', 'available'),
    ]);

    expect(selected).toBeDefined();
    expect(selected?.id).toBe('docker');
  });

  it('is deterministic between equally-ranked capabilities', () => {
    // Registration order is the only tie-break; it must not depend on which
    // capability happens to resolve first.
    const items = [snapshot('claude-code', 'relevant'), snapshot('docker', 'relevant')];
    expect(selectCapsuleCapability(items)?.id).toBe('claude-code');
    expect(selectCapsuleCapability([...items].reverse())?.id).toBe('docker');
  });

  it('keeps the capsule empty when nothing earned presence', () => {
    expect(selectCapsuleCapability([])).toBeUndefined();
  });
});

function makeSession(foreground: string | null): Session {
  return {
    session_id: 'agent-a:work',
    agent_id: 'agent-a',
    session_name: 'work',
    status: 'active',
    window_count: 1,
    attached_clients: 1,
    foreground_command: foreground,
    last_activity: '2026-09-01T12:00:00.000Z',
  };
}

function input(overrides: Partial<CapsuleCapabilityInput> = {}): CapsuleCapabilityInput {
  return {
    session: makeSession('bash'),
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

describe('capsule capability wiring', () => {
  it('shows nothing while the session has not used Claude Code', () => {
    expect(resolveCapsuleCapabilities(input()).capability).toBeUndefined();
  });

  it('marks Claude Code active while it is the foreground command', () => {
    const { capability } = resolveCapsuleCapabilities(
      input({ facts: { sessionForegroundCommand: 'claude.exe' } }),
    );

    expect(capability?.id).toBe('claude-code');
    expect(capability?.label).toBe('Claude Code');
    expect(capability?.state).toBe('active');
  });

  it('keeps Claude Code relevant after it has been seen, once the shell returns', () => {
    const { capability } = resolveCapsuleCapabilities(
      input({
        facts: {
          sessionForegroundCommand: 'bash',
          sessionObservedCommands: ['bash', 'claude.exe'],
        },
      }),
    );

    expect(capability?.state).toBe('relevant');
  });

  it('shows nothing without a session', () => {
    const { capability } = resolveCapsuleCapabilities(
      input({ session: null, facts: { sessionForegroundCommand: 'claude' } }),
    );

    expect(capability).toBeUndefined();
  });

  it('opens the capability where it lives when activated', () => {
    const onToolChange = vi.fn();
    const onSurfaceChange = vi.fn();

    resolveCapsuleCapabilities(
      input({ facts: { sessionForegroundCommand: 'claude' }, onToolChange, onSurfaceChange }),
    ).capability?.onActivate();

    expect(onToolChange).toHaveBeenCalledWith('claude-code');
    expect(onSurfaceChange).toHaveBeenCalledTimes(1);
  });

  it('offers the capabilities that earned no chip through disclosure', () => {
    const { capability, disclosure } = resolveCapsuleCapabilities(
      input({ facts: { sessionForegroundCommand: 'claude.exe' } }),
    );

    // `available` earns no capsule presence, but it must stay reachable: the
    // capsule is the only surface a user watching a session has in front of them.
    expect(capability?.id).toBe('claude-code');
    const ids = disclosure?.entries.map((entry) => entry.id) ?? [];
    expect(ids).toContain('session');
    expect(ids).toContain('agent');
    // The chip's capability is already in front of the user — it is not also
    // listed as something to go and find.
    expect(ids).not.toContain('claude-code');
  });

  it('activates a disclosed capability the same way as the chip', () => {
    const onToolChange = vi.fn();
    const onSurfaceChange = vi.fn();

    const { disclosure } = resolveCapsuleCapabilities(input({ onToolChange, onSurfaceChange }));
    const entries = disclosure?.entries ?? [];

    expect(entries.length).toBeGreaterThan(0);
    disclosure?.onSelect(entries[0].id);

    expect(onToolChange).toHaveBeenCalledWith(entries[0].id);
    expect(onSurfaceChange).toHaveBeenCalledTimes(1);
  });

  it('never offers a hidden capability for discovery', () => {
    // `files` needs file ops, so without them it is unavailable — hidden, not
    // disclosed. Absent means absent, not "one more click away".
    const ids = resolveCapsuleCapabilities(input({ fileOps: null })).disclosure?.entries
      .map((entry) => entry.id) ?? [];

    expect(ids).not.toContain('files');
  });
});
