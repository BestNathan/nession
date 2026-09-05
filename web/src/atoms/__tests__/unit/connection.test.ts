import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import {
  p2pStateAtom,
  activeUrlAtom, effectiveModeAtom, isSwitchingAtom,
} from '@/atoms/connection';
import { terminalSessionStateAtom } from '@/terminal/state/session';
import { lastResizeAtom } from '@/terminal/state/terminal';
import { manualOverrideAtom, forcedRelayAtom, attachInfoAtom, orderedUrlsAtom } from '@/atoms/session';

describe('base atoms', () => {
  it('start with defaults', () => {
    const store = createStore();
    expect(store.get(p2pStateAtom)).toBe('disconnected');
    expect(store.get(terminalSessionStateAtom)).toBe('idle');
    expect(store.get(lastResizeAtom)).toBeNull();
  });
});

describe('derived atoms', () => {
  it('activeUrlAtom: override > orderedUrls > probe > attachInfo', () => {
    const store = createStore();
    expect(store.get(activeUrlAtom)).toBeNull();
    store.set(orderedUrlsAtom, ['ws://attach/ws']);
    expect(store.get(activeUrlAtom)).toBe('ws://attach/ws');
    store.set(manualOverrideAtom, 'ws://b/ws');
    expect(store.get(activeUrlAtom)).toBe('ws://b/ws');
    store.set(manualOverrideAtom, null);
    store.set(orderedUrlsAtom, []);
    store.set(attachInfoAtom, {
      mode: 'p2p',
      session_id: 's',
      agent_address: 'ws://legacy/ws',
    });
    expect(store.get(activeUrlAtom)).toBe('ws://legacy/ws');
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
    store.set(p2pStateAtom, 'disconnected');
    store.set(terminalSessionStateAtom, 'failed');
    expect(store.get(isSwitchingAtom)).toBe(false);
  });
});
