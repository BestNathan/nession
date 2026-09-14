import { describe, expect, it, vi } from 'vitest';
import type { CapabilityId, CapabilitySnapshot, CapabilityState } from '@/features/capabilities';
import type { Session } from '@/types';
import {
  resolveCapsuleCapabilityPresence,
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
    expect(resolveCapsuleCapabilityPresence(input())).toBeUndefined();
  });

  it('marks Claude Code active while it is the foreground command', () => {
    const presence = resolveCapsuleCapabilityPresence(
      input({ facts: { sessionForegroundCommand: 'claude' } }),
    );

    expect(presence?.id).toBe('claude-code');
    expect(presence?.label).toBe('Claude Code');
    expect(presence?.state).toBe('active');
  });

  it('keeps Claude Code relevant after it has been seen, once the shell returns', () => {
    const presence = resolveCapsuleCapabilityPresence(
      input({
        facts: {
          sessionForegroundCommand: 'bash',
          sessionObservedCommands: ['bash', 'claude'],
        },
      }),
    );

    expect(presence?.state).toBe('relevant');
  });

  it('shows nothing without a session', () => {
    expect(
      resolveCapsuleCapabilityPresence(
        input({ session: null, facts: { sessionForegroundCommand: 'claude' } }),
      ),
    ).toBeUndefined();
  });

  it('opens the capability where it lives when activated', () => {
    const onToolChange = vi.fn();
    const onSurfaceChange = vi.fn();

    resolveCapsuleCapabilityPresence(
      input({ facts: { sessionForegroundCommand: 'claude' }, onToolChange, onSurfaceChange }),
    )?.onActivate();

    expect(onToolChange).toHaveBeenCalledWith('claude-code');
    expect(onSurfaceChange).toHaveBeenCalledTimes(1);
  });
});
