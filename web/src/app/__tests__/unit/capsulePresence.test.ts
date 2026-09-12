import { describe, expect, it } from 'vitest';
import type { CapabilityId, CapabilityState } from '@/features/capabilities';
import { selectCapsuleCapability, type CapsuleCapabilityCandidate } from '../../capsulePresence';

function candidate(id: CapabilityId, state: CapabilityState): CapsuleCapabilityCandidate {
  return { id, label: id, state };
}

describe('capsule capability presence', () => {
  it('gives no presence to a capability that is merely available', () => {
    expect(selectCapsuleCapability([candidate('claude-code', 'available')])).toBeUndefined();
  });

  it('gives no presence to an unavailable capability', () => {
    expect(selectCapsuleCapability([candidate('claude-code', 'unavailable')])).toBeUndefined();
  });

  it('lets a relevant capability appear', () => {
    expect(selectCapsuleCapability([candidate('claude-code', 'relevant')])?.id).toBe('claude-code');
  });

  it('lets an active capability appear', () => {
    expect(selectCapsuleCapability([candidate('claude-code', 'active')])?.id).toBe('claude-code');
  });

  it('keeps the capsule bounded — one capsule, one capability', () => {
    const selected = selectCapsuleCapability([
      candidate('claude-code', 'relevant'),
      candidate('docker', 'active'),
      candidate('git', 'available'),
    ]);
    expect(selected?.id).toBe('docker');
  });

  it('prefers the active capability over a relevant one regardless of order', () => {
    const selected = selectCapsuleCapability([
      candidate('docker', 'active'),
      candidate('claude-code', 'relevant'),
    ]);
    expect(selected?.id).toBe('docker');
  });

  it('is deterministic between equally-ranked capabilities', () => {
    // Registration order is the only tie-break; it must not depend on which
    // capability happens to resolve first.
    const items = [candidate('claude-code', 'relevant'), candidate('docker', 'relevant')];
    expect(selectCapsuleCapability(items)?.id).toBe('claude-code');
    expect(selectCapsuleCapability([...items].reverse())?.id).toBe('docker');
  });

  it('keeps the capsule empty when nothing earned presence', () => {
    expect(selectCapsuleCapability([])).toBeUndefined();
  });
});
