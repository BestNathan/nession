// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getOrCreateClientId } from '@/platform/socket/clientId';

/**
 * The identity is read by modules that also run in contexts without storage
 * (unit tests, workers). Reading it must not throw there, and the answer must
 * stay stable for the life of the process — the ControlLease compares it
 * against the holder the Agent publishes (#2157).
 */
describe('getOrCreateClientId without localStorage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a stable id instead of throwing when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    const first = getOrCreateClientId();
    const second = getOrCreateClientId();
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });
});
