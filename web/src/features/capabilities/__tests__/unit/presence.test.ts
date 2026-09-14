import { describe, expect, it } from 'vitest';
import {
  resolveCapabilityPresence,
  resolveCapabilityPresences,
} from '../../presence';
import type { CapabilitySnapshot, CapabilityState } from '../../model';

function snapshot(state: CapabilityState, id: string = state): CapabilitySnapshot {
  return {
    id,
    title: id,
    scope: { sessionId: 'session-a' },
    state,
  };
}

describe('resolveCapabilityPresence', () => {
  it('keeps semantic state separate from default workspace presence', () => {
    const states: CapabilityState[] = [
      'unavailable',
      'available',
      'relevant',
      'active',
    ];

    const levels = resolveCapabilityPresences(
      states.map((state) => snapshot(state)),
      { surface: 'workspace' },
    ).map((presence) => presence.level);

    expect(levels).toEqual(['hidden', 'discoverable', 'contextual', 'contextual']);
  });

  it('promotes an active capability only in the Session interaction layer', () => {
    const active = snapshot('active', 'claude-code');

    expect(resolveCapabilityPresence(active, { surface: 'capsule' }).level).toBe('prominent');
    expect(resolveCapabilityPresence(active, { surface: 'workspace' }).level).toBe('contextual');
    expect(active.state).toBe('active');
  });

  it('keeps an available capability discoverable rather than promoting it', () => {
    const available = snapshot('available', 'git');

    expect(resolveCapabilityPresence(available, { surface: 'workspace' }).level).toBe('discoverable');
    expect(resolveCapabilityPresence(available, { surface: 'capsule' }).level).toBe('discoverable');
  });

  it('never promotes an unavailable capability into visible chrome', () => {
    const unavailable = snapshot('unavailable', 'docker');

    expect(resolveCapabilityPresence(unavailable, { surface: 'workspace' }).level).toBe('hidden');
    expect(resolveCapabilityPresence(unavailable, { surface: 'capsule' }).level).toBe('hidden');
  });
});
