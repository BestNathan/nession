import { describe, it, expect } from 'vitest';
import { createAttachGate } from '@/terminal/adapters/TransportAttachGate';

describe('createAttachGate', () => {
  it('returns true only when phase is attached', () => {
    let phase: 'connecting' | 'attached' = 'connecting';
    const gate = createAttachGate(() => phase);
    expect(gate()).toBe(false);
    phase = 'attached';
    expect(gate()).toBe(true);
  });
});
