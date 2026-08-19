import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import {
  p2pStateAtom, p2pConnectionAtom,
  activeUrlAtom, effectiveModeAtom, isSwitchingAtom,
} from '@/atoms/connection';
import { terminalSessionStateAtom } from '@/terminal/state/session';
import { lastResizeAtom } from '@/terminal/state/terminal';
import { manualOverrideAtom, forcedRelayAtom, attachInfoAtom } from '@/atoms/session';

describe('base atoms', () => {
  it('start with defaults', () => {
    const store = createStore();
    expect(store.get(p2pStateAtom)).toBe('disconnected');
    expect(store.get(p2pConnectionAtom)).toBeNull();
    expect(store.get(terminalSessionStateAtom)).toBe('idle');
    expect(store.get(lastResizeAtom)).toBeNull();
  });
});

describe('derived atoms', () => {
  it('activeUrlAtom: override > probe > null', () => {
    const store = createStore();
    // No probe data, no override → null
    expect(store.get(activeUrlAtom)).toBeNull();
    // Manual override wins regardless of probe
    store.set(manualOverrideAtom, 'ws://b/ws');
    expect(store.get(activeUrlAtom)).toBe('ws://b/ws');
  });

  it('activeUrlAtom: null when forcedRelay', () => {
    const store = createStore();
    store.set(manualOverrideAtom, 'ws://a/ws');
    store.set(forcedRelayAtom, true);
    expect(store.get(activeUrlAtom)).toBeNull();
  });

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
  });
});
