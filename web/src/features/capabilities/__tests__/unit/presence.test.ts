import { describe, expect, it } from 'vitest';
import {
  resolveCapabilityPresence,
  resolveCapabilityPresences,
} from '../../presence';
import type { CapabilitySnapshot, CapabilityState } from '../../model';

function snapshot(state: CapabilityState, id = state): CapabilitySnapshot {
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

  it('promotes an active capability in Session and Capsule without changing its state', () => {
    const active = snapshot('active', 'claude-code');

    expect(resolveCapabilityPresence(active, { surface: 'session' }).level).toBe('prominent');
    expect(resolveCapabilityPresence(active, { surface: 'capsule' }).level).toBe('prominent');
    expect(active.state).toBe('active');
  });

  it('allows Nession product policy to promote a non-unavailable capability', () => {
    const available = snapshot('available', 'git');

    expect(
      resolveCapabilityPresence(available, {
        surface: 'workspace',
        prominentCapabilityIds: ['git'],
      }).level,
    ).toBe('prominent');
  });

  it('never promotes an unavailable capability into visible chrome', () => {
    const unavailable = snapshot('unavailable', 'docker');

    expect(
      resolveCapabilityPresence(unavailable, {
        surface: 'session',
        prominentCapabilityIds: ['docker'],
      }).level,
    ).toBe('hidden');
  });
});
