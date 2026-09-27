import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { effectiveModeAtom, isSwitchingAtom } from '../../route';
import { p2pStateAtom } from '@/platform/attach/state';
import { terminalSessionStateAtom } from '@/product/terminal/state/session';
import { lastResizeAtom } from '@/product/terminal/state/terminal';
import { manualOverrideAtom, forcedRelayAtom, attachInfoAtom } from '@/product/session/state';

describe('base atoms', () => {
  it('start with defaults', () => {
    const store = createStore();
    expect(store.get(p2pStateAtom)).toBe('disconnected');
    expect(store.get(terminalSessionStateAtom)).toBe('idle');
    expect(store.get(lastResizeAtom)).toBeNull();
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

  it('isSwitchingAtom', () => {
    const store = createStore();
    expect(store.get(isSwitchingAtom)).toBe(false);
    store.set(manualOverrideAtom, 'ws://b/ws');
    expect(store.get(isSwitchingAtom)).toBe(true);
    store.set(p2pStateAtom, 'connected');
    expect(store.get(isSwitchingAtom)).toBe(false);
    store.set(p2pStateAtom, 'disconnected');
    store.set(terminalSessionStateAtom, 'failed');
    expect(store.get(isSwitchingAtom)).toBe(false);
  });
});
