// web/src/atoms/__tests__/session.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import type { Session } from '@/types';
import type { AttachChoice } from '@/components/env/AttachDialog';
import { p2pConnectionAtom, p2pStateAtom, p2pEpochAtom } from '@/atoms/connection';
import type { P2PConnection } from '@/hooks/useP2PConnection';
import {
  sessionIdAtom, sessionNameAtom, attachInfoAtom, orderedUrlsAtom,
  manualOverrideAtom, forcedRelayAtom, rendererAtom, envRefsAtom,
  agentIdAtom, addressesAtom, hasActiveSessionAtom, sessionIdFromUrlAtom,
  attachToSessionAtom, disconnectAtom, switchAddressAtom,
  attachDialogSessionAtom,
} from '@/atoms/session';
import { terminalSessionStateAtom } from '@/terminal/state/session';

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
    expect(store.get(sessionIdFromUrlAtom)).toBeNull();
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

  it('attachToSessionAtom clears the previous P2P connection (session switch)', () => {
    const store = createStore();
    store.set(p2pConnectionAtom, {} as P2PConnection);
    store.set(attachToSessionAtom, { session: makeSession(), choice: makeChoice(makeSession()), navigate });
    expect(store.get(p2pConnectionAtom)).toBeNull();
  });

  it('disconnectAtom clears all atoms', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    store.set(sessionNameAtom, 'sess');
    store.set(manualOverrideAtom, 'ws://a/ws');
    store.set(p2pStateAtom, 'connected');
    store.set(disconnectAtom, navigate);
    expect(store.get(sessionIdAtom)).toBe('');
    expect(store.get(sessionNameAtom)).toBe('');
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(p2pStateAtom)).toBe('disconnected');
  });

  it('switchAddressAtom sets override and resets state', () => {
    const store = createStore();
    store.set(switchAddressAtom, 'ws://b/ws');
    expect(store.get(manualOverrideAtom)).toBe('ws://b/ws');
    expect(store.get(forcedRelayAtom)).toBe(false);
  });

  it('switchAddressAtom is a no-op when re-selecting the current override', () => {
    const store = createStore();
    // First switch sets the override.
    store.set(switchAddressAtom, 'ws://same/ws');
    const epochAfterFirst = store.get(p2pEpochAtom);
    expect(epochAfterFirst).toBe(1);

    // Simulate connection having come up since the first switch — so the
    // second switch has a non-idle state to preserve.
    store.set(terminalSessionStateAtom, 'attached');

    // Second switch with the same URL must NOT tear down the connection
    // (would otherwise flash a spinner for a logical no-op).
    store.set(switchAddressAtom, 'ws://same/ws');
    expect(store.get(manualOverrideAtom)).toBe('ws://same/ws');
    expect(store.get(p2pEpochAtom)).toBe(epochAfterFirst); // epoch unchanged
    expect(store.get(terminalSessionStateAtom)).toBe('attached'); // state preserved
  });

  it('switchAddressAtom fires when override changes (null → url, even to same URL Auto resolved to)', () => {
    const store = createStore();
    // manualOverride starts null (Auto mode).  Selecting an explicit URL
    // must still bump the epoch / trigger the switch, because the *source*
    // of the URL changed even if the resolved URL happens to match.
    expect(store.get(manualOverrideAtom)).toBeNull();
    store.set(switchAddressAtom, 'ws://auto-resolved/ws');
    expect(store.get(manualOverrideAtom)).toBe('ws://auto-resolved/ws');
    expect(store.get(p2pEpochAtom)).toBe(1);
  });
});
