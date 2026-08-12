// web/src/atoms/__tests__/session.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import type { Session } from '../../types';
import type { AttachChoice } from '../../components/env/AttachDialog';
import {
  sessionIdAtom, sessionNameAtom, attachInfoAtom, orderedUrlsAtom,
  manualOverrideAtom, forcedRelayAtom, rendererAtom, envRefsAtom,
  agentIdAtom, addressesAtom, hasActiveSessionAtom,
  attachToSessionAtom, disconnectAtom, switchAddressAtom,
  attachDialogSessionAtom,
} from '../session';

const navigate = () => {};

function makeSession(): Session {
  return {
    session_id: 'agent:sess', session_name: 'sess', agent_id: 'agent',
    status: 'active', window_count: 1, attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
  };
}

function makeChoice(session: Session): AttachChoice {
  return {
    mode: 'auto',
    attachInfo: { mode: 'p2p', session_id: session.session_id, connection_token: 'tok',
      addresses: [{ url: 'ws://a/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' }],
    },
    orderedUrls: ['ws://a/ws'], latencies: [], selectedUrl: null,
    renderer: 'webgl', envRefs: [],
  } as AttachChoice;
}

describe('base atoms', () => {
  it('start with defaults', () => {
    const store = createStore();
    expect(store.get(sessionIdAtom)).toBe('');
    expect(store.get(sessionNameAtom)).toBe('');
    expect(store.get(attachInfoAtom)).toBeNull();
    expect(store.get(orderedUrlsAtom)).toEqual([]);
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(forcedRelayAtom)).toBe(false);
    expect(store.get(rendererAtom)).toBe('webgl');
    expect(store.get(envRefsAtom)).toEqual([]);
    expect(store.get(attachDialogSessionAtom)).toBeNull();
  });
});

describe('derived atoms', () => {
  it('agentIdAtom extracts agent from sessionId', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'k8s-agent:1');
    expect(store.get(agentIdAtom)).toBe('k8s-agent');
  });

  it('addressesAtom returns addresses from attachInfo', () => {
    const store = createStore();
    store.set(attachInfoAtom, makeChoice(makeSession()).attachInfo);
    expect(store.get(addressesAtom)).toHaveLength(1);
  });

  it('hasActiveSessionAtom', () => {
    const store = createStore();
    expect(store.get(hasActiveSessionAtom)).toBe(false);
    store.set(sessionIdAtom, 'agent:sess');
    expect(store.get(hasActiveSessionAtom)).toBe(true);
  });
});

describe('action atoms', () => {
  it('attachToSessionAtom writes all base atoms', () => {
    const store = createStore();
    store.set(attachToSessionAtom, { session: makeSession(), choice: makeChoice(makeSession()), navigate });
    expect(store.get(sessionIdAtom)).toBe('agent:sess');
    expect(store.get(sessionNameAtom)).toBe('sess');
    expect(store.get(attachInfoAtom)?.connection_token).toBe('tok');
    expect(store.get(orderedUrlsAtom)).toEqual(['ws://a/ws']);
    expect(store.get(rendererAtom)).toBe('webgl');
    expect(store.get(envRefsAtom)).toEqual([]);
    expect(store.get(attachDialogSessionAtom)).toBeNull();
  });

  it('disconnectAtom clears', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    store.set(disconnectAtom, navigate);
    expect(store.get(sessionIdAtom)).toBe('');
  });

  it('switchAddressAtom sets override and resets state', () => {
    const store = createStore();
    store.set(switchAddressAtom, 'ws://b/ws');
    expect(store.get(manualOverrideAtom)).toBe('ws://b/ws');
    expect(store.get(forcedRelayAtom)).toBe(false);
  });
});
