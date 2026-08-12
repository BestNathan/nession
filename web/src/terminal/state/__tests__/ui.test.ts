// web/src/terminal/state/__tests__/ui.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { bannerAtomFamily, bannerAttemptAtomFamily } from '../ui';

describe('bannerAtomFamily', () => {
  it('defaults to none', () => {
    const store = createStore();
    expect(store.get(bannerAtomFamily('s1'))).toBe('none');
  });

  it('is writable through the reconnect states', () => {
    const store = createStore();
    store.set(bannerAtomFamily('s1'), 'reconnecting');
    expect(store.get(bannerAtomFamily('s1'))).toBe('reconnecting');
    store.set(bannerAtomFamily('s1'), 'failed');
    expect(store.get(bannerAtomFamily('s1'))).toBe('failed');
  });

  it('is isolated per session', () => {
    const store = createStore();
    store.set(bannerAtomFamily('s1'), 'failed');
    expect(store.get(bannerAtomFamily('s2'))).toBe('none');
  });
});

describe('bannerAttemptAtomFamily', () => {
  it('defaults to 0 and counts attempts', () => {
    const store = createStore();
    expect(store.get(bannerAttemptAtomFamily('s1'))).toBe(0);
    store.set(bannerAttemptAtomFamily('s1'), 3);
    expect(store.get(bannerAttemptAtomFamily('s1'))).toBe(3);
    expect(store.get(bannerAttemptAtomFamily('s2'))).toBe(0);
  });
});
