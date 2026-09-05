// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreateClientId } from '@/services/socket/clientId';

const CLIENT_ID_KEY = 'nessioclientid';

describe('getOrCreateClientId', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates a fresh id on first call and persists it', () => {
    const id = getOrCreateClientId();
    expect(id).toBeTruthy();
    expect(localStorage.getItem(CLIENT_ID_KEY)).toBe(id);
  });

  it('returns the same id on subsequent calls', () => {
    const first = getOrCreateClientId();
    const second = getOrCreateClientId();
    expect(second).toBe(first);
  });

  it('reuses an already-stored id instead of generating a new one', () => {
    localStorage.setItem(CLIENT_ID_KEY, 'fixed-client-id');
    expect(getOrCreateClientId()).toBe('fixed-client-id');
  });
});
