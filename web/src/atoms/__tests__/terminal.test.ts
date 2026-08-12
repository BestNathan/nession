// web/src/atoms/__tests__/terminal.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import type { AttachInfo, Session } from '../../types';
import type { AttachChoice } from '../../components/env/AttachDialog';
import {
  sessionIdAtom, sessionNameAtom, attachInfoAtom, orderedUrlsAtom,
  manualOverrideAtom, forcedRelayAtom, p2pStateAtom, rendererAtom, envRefsAtom,
  activeUrlAtom, effectiveModeAtom, isSwitchingAtom, hasActiveSessionAtom,
  attachToSessionAtom, disconnectAtom, switchAddressAtom,
} from '../terminal';

function makeAttachInfo(overrides?: Partial<AttachInfo>): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:sess',
    connection_token: 'tok',
    addresses: [
      { url: 'ws://a:1/ws', label: 'tailscale', status: 'reachable' },
      { url: 'ws://b:2/ws', label: 'lan', status: 'reachable' },
    ],
    ...overrides,
  } as AttachInfo;
}

function makeSession(): Session {
  return {
    session_id: 'agent:sess',
    session_name: 'sess',
    agent_id: 'agent',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
  };
}

function makeChoice(session: Session, overrides?: Partial<AttachChoice>): AttachChoice {
  return {
    mode: 'auto',
    attachInfo: makeAttachInfo({ session_id: session.session_id }),
    orderedUrls: ['ws://a:1/ws', 'ws://b:2/ws'],
    latencies: [],
    selectedUrl: null,
    renderer: 'webgl',
    envRefs: [],
    ...overrides,
  } as AttachChoice;
}

const navigate = () => {};

describe('base atoms', () => {
  it('start with default values', () => {
    const store = createStore();
    expect(store.get(sessionIdAtom)).toBe('');
    expect(store.get(sessionNameAtom)).toBe('');
    expect(store.get(attachInfoAtom)).toBeNull();
    expect(store.get(orderedUrlsAtom)).toEqual([]);
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(forcedRelayAtom)).toBe(false);
    expect(store.get(p2pStateAtom)).toBe('disconnected');
    expect(store.get(rendererAtom)).toBe('webgl');
    expect(store.get(envRefsAtom)).toEqual([]);
  });
});

describe('derived atoms', () => {
  it('activeUrlAtom: falls back to first ordered url when no override', () => {
    const store = createStore();
    store.set(orderedUrlsAtom, ['ws://a:1/ws', 'ws://b:2/ws']);
    expect(store.get(activeUrlAtom)).toBe('ws://a:1/ws');
  });

  it('activeUrlAtom: manual override wins', () => {
    const store = createStore();
    store.set(orderedUrlsAtom, ['ws://a:1/ws', 'ws://b:2/ws']);
    store.set(manualOverrideAtom, 'ws://b:2/ws');
    expect(store.get(activeUrlAtom)).toBe('ws://b:2/ws');
  });

  it('activeUrlAtom: returns null when forcedRelay (override ignored)', () => {
    const store = createStore();
    store.set(orderedUrlsAtom, ['ws://a:1/ws']);
    store.set(manualOverrideAtom, 'ws://b:2/ws');
    store.set(forcedRelayAtom, true);
    expect(store.get(activeUrlAtom)).toBeNull();
  });

  it('activeUrlAtom: returns null for empty orderedUrls', () => {
    const store = createStore();
    expect(store.get(activeUrlAtom)).toBeNull();
  });

  it('effectiveModeAtom: p2p when attachInfo says p2p and not forced relay', () => {
    const store = createStore();
    store.set(attachInfoAtom, makeAttachInfo({ mode: 'p2p' }));
    expect(store.get(effectiveModeAtom)).toBe('p2p');
  });

  it('effectiveModeAtom: relay when forcedRelay is true', () => {
    const store = createStore();
    store.set(attachInfoAtom, makeAttachInfo({ mode: 'p2p' }));
    store.set(forcedRelayAtom, true);
    expect(store.get(effectiveModeAtom)).toBe('relay');
  });

  it('effectiveModeAtom: relay when no attachInfo', () => {
    const store = createStore();
    expect(store.get(effectiveModeAtom)).toBe('relay');
  });

  it('isSwitchingAtom: true when manual override set and not connected', () => {
    const store = createStore();
    store.set(manualOverrideAtom, 'ws://b:2/ws');
    store.set(p2pStateAtom, 'connecting');
    expect(store.get(isSwitchingAtom)).toBe(true);
  });

  it('isSwitchingAtom: false when override set but already connected', () => {
    const store = createStore();
    store.set(manualOverrideAtom, 'ws://b:2/ws');
    store.set(p2pStateAtom, 'connected');
    expect(store.get(isSwitchingAtom)).toBe(false);
  });

  it('isSwitchingAtom: false when no override', () => {
    const store = createStore();
    store.set(p2pStateAtom, 'connecting');
    expect(store.get(isSwitchingAtom)).toBe(false);
  });

  it('hasActiveSessionAtom: true when sessionId is set', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    expect(store.get(hasActiveSessionAtom)).toBe(true);
  });

  it('hasActiveSessionAtom: false by default', () => {
    const store = createStore();
    expect(store.get(hasActiveSessionAtom)).toBe(false);
  });
});

describe('action atoms', () => {
  it('attachToSessionAtom writes all base atoms', () => {
    const store = createStore();
    const session = makeSession();
    const choice = makeChoice(session, {
      selectedUrl: 'ws://a:1/ws',
      renderer: 'canvas',
      envRefs: [{ source: 'server', name: '.env' }],
    });

    store.set(attachToSessionAtom, { session, choice, navigate });

    expect(store.get(sessionIdAtom)).toBe('agent:sess');
    expect(store.get(sessionNameAtom)).toBe('sess');
    expect(store.get(attachInfoAtom)?.connection_token).toBe('tok');
    expect(store.get(orderedUrlsAtom)).toEqual(['ws://a:1/ws', 'ws://b:2/ws']);
    expect(store.get(rendererAtom)).toBe('canvas');
    expect(store.get(envRefsAtom)).toEqual([{ source: 'server', name: '.env' }]);
    expect(store.get(manualOverrideAtom)).toBe('ws://a:1/ws');
    expect(store.get(forcedRelayAtom)).toBe(false);
  });

  it('disconnectAtom clears all atoms', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    store.set(sessionNameAtom, 'sess');
    store.set(manualOverrideAtom, 'ws://a:1/ws');
    store.set(p2pStateAtom, 'connected');

    store.set(disconnectAtom, navigate);

    expect(store.get(sessionIdAtom)).toBe('');
    expect(store.get(sessionNameAtom)).toBe('');
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(p2pStateAtom)).toBe('disconnected');
  });

  it('switchAddressAtom sets manualOverride and resets forcedRelay', () => {
    const store = createStore();
    store.set(forcedRelayAtom, true);
    store.set(switchAddressAtom, 'ws://b:2/ws');
    expect(store.get(manualOverrideAtom)).toBe('ws://b:2/ws');
    expect(store.get(forcedRelayAtom)).toBe(false);

    store.set(switchAddressAtom, null);
    expect(store.get(manualOverrideAtom)).toBeNull();
  });
});
