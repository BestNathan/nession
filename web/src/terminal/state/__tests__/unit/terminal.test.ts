// web/src/terminal/state/__tests__/terminal.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import {
  terminalSizeAtomFamily,
  terminalFocusAtomFamily,
  terminalSelectionAtomFamily,
  terminalTitleAtomFamily,
} from '@/terminal/state/terminal';

describe('terminalSizeAtomFamily', () => {
  it('defaults to 80x24', () => {
    const store = createStore();
    expect(store.get(terminalSizeAtomFamily('s1'))).toEqual({ cols: 80, rows: 24 });
  });

  it('is writable and isolated per session', () => {
    const store = createStore();
    store.set(terminalSizeAtomFamily('s1'), { cols: 120, rows: 40 });
    expect(store.get(terminalSizeAtomFamily('s1'))).toEqual({ cols: 120, rows: 40 });
    expect(store.get(terminalSizeAtomFamily('s2'))).toEqual({ cols: 80, rows: 24 });
  });
});

describe('terminalFocusAtomFamily', () => {
  it('defaults to false and can be set per session', () => {
    const store = createStore();
    expect(store.get(terminalFocusAtomFamily('s1'))).toBe(false);
    store.set(terminalFocusAtomFamily('s1'), true);
    expect(store.get(terminalFocusAtomFamily('s1'))).toBe(true);
    expect(store.get(terminalFocusAtomFamily('s2'))).toBe(false);
  });
});

describe('terminalSelectionAtomFamily & terminalTitleAtomFamily', () => {
  it('default to empty string and are writable', () => {
    const store = createStore();
    expect(store.get(terminalSelectionAtomFamily('s1'))).toBe('');
    store.set(terminalSelectionAtomFamily('s1'), 'abc');
    expect(store.get(terminalSelectionAtomFamily('s1'))).toBe('abc');

    expect(store.get(terminalTitleAtomFamily('s1'))).toBe('');
    store.set(terminalTitleAtomFamily('s1'), 'htop');
    expect(store.get(terminalTitleAtomFamily('s1'))).toBe('htop');
  });
});
