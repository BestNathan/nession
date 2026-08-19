// web/src/terminal/state/__tests__/layout.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { sidebarOpenAtom, panelSizesAtom } from '@/terminal/state/layout';

describe('sidebarOpenAtom', () => {
  it('defaults to false and can be toggled', () => {
    const store = createStore();
    expect(store.get(sidebarOpenAtom)).toBe(false);
    store.set(sidebarOpenAtom, true);
    expect(store.get(sidebarOpenAtom)).toBe(true);
  });
});

describe('panelSizesAtom', () => {
  it('defaults to [70, 30] and is writable', () => {
    const store = createStore();
    expect(store.get(panelSizesAtom)).toEqual([70, 30]);
    store.set(panelSizesAtom, [50, 50]);
    expect(store.get(panelSizesAtom)).toEqual([50, 50]);
  });
});
