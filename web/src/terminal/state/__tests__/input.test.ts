// web/src/terminal/state/__tests__/input.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { inputModeAtomFamily, inputValueAtomFamily } from '../input';

describe('inputModeAtomFamily', () => {
  it('defaults to terminal mode', () => {
    const store = createStore();
    expect(store.get(inputModeAtomFamily('s1'))).toEqual({ type: 'terminal' });
  });

  it('supports setting a custom mode with id', () => {
    const store = createStore();
    store.set(inputModeAtomFamily('s1'), { type: 'custom', id: 'fzf' });
    expect(store.get(inputModeAtomFamily('s1'))).toEqual({ type: 'custom', id: 'fzf' });
  });

  it('is isolated per session', () => {
    const store = createStore();
    store.set(inputModeAtomFamily('s1'), { type: 'search' });
    expect(store.get(inputModeAtomFamily('s1'))).toEqual({ type: 'search' });
    expect(store.get(inputModeAtomFamily('s2'))).toEqual({ type: 'terminal' });
  });
});

describe('inputValueAtomFamily', () => {
  it('defaults to empty string and is writable', () => {
    const store = createStore();
    expect(store.get(inputValueAtomFamily('s1'))).toBe('');
    store.set(inputValueAtomFamily('s1'), 'ls -la');
    expect(store.get(inputValueAtomFamily('s1'))).toBe('ls -la');
  });
});
