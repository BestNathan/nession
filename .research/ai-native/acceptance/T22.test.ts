import { describe, expect, it } from 'vitest';
import { computeReconnectDelayMs } from '@/platform/socket';

describe('research acceptance T22', () => {
  it('exposes deterministic reconnect backoff policy independently of the service', () => {
    expect(computeReconnectDelayMs(0, 1_000)).toBe(1_000);
    expect(computeReconnectDelayMs(1, 1_000)).toBe(2_000);
    expect(computeReconnectDelayMs(4, 1_000)).toBe(16_000);
    expect(computeReconnectDelayMs(5, 1_000)).toBe(30_000);
    expect(computeReconnectDelayMs(12, 5)).toBe(20_480);
    expect(computeReconnectDelayMs(20, 1_000)).toBe(30_000);
    expect(computeReconnectDelayMs(4, 1_000)).toBe(16_000);
  });
});
