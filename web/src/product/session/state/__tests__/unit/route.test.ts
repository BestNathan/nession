import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { effectiveModeAtom } from '../../route';
import { terminalSessionStateAtom } from '@/product/terminal/state/session';
import { forcedRelayAtom, attachInfoAtom } from '@/product/session/state';

describe('base atoms', () => {
  it('start with defaults', () => {
    const store = createStore();
    expect(store.get(terminalSessionStateAtom)).toBe('idle');
  });
});

describe('derived atoms', () => {
  it('effectiveModeAtom: p2p vs relay vs forced', () => {
    const store = createStore();
    expect(store.get(effectiveModeAtom)).toBe('relay'); // no attachInfo
    store.set(attachInfoAtom, { mode: 'p2p', session_id: 'sess' });
    expect(store.get(effectiveModeAtom)).toBe('p2p');
    store.set(forcedRelayAtom, true);
    expect(store.get(effectiveModeAtom)).toBe('relay');
  });
});
