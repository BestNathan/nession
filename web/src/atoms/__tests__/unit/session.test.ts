// web/src/atoms/__tests__/session.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import type { Session } from '@/types';
import type { AttachChoice } from '@/features/sessions/components/AttachDialog';
import { p2pStateAtom, routeIntentEpochAtom } from '@/atoms/connection';
import {
  sessionIdAtom, sessionNameAtom, attachInfoAtom, orderedUrlsAtom,
  manualOverrideAtom, forcedRelayAtom, rendererAtom, envRefsAtom,
  agentIdAtom, addressesAtom, hasActiveSessionAtom, sessionIdFromUrlAtom,
  attachToSessionAtom, disconnectAtom, switchAddressAtom,
  attachDialogSessionAtom, attachDialogIntentAtom,
} from '@/atoms/session';
import { terminalSessionStateAtom } from '@/features/terminal/state/session';

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

  it('attachToSessionAtom bumps the route intent when re-attaching the session already attached', () => {
    // Repro for #668: a second confirm on the SAME session carries a fresh
    // connection token (server mints one per attach-info request). Without a
    // route-intent bump the leased SessionRuntime silently rebuilds its agent
    // socket under the stale 'attached' phase and never re-attaches — the
    // terminal freezes (no output, no input, tmux client dropped).
    const store = createStore();
    const session = makeSession();
    const first = makeChoice(session);
    store.set(attachToSessionAtom, { session, choice: first, navigate });
    const epochAfterFirst = store.get(routeIntentEpochAtom);
    expect(epochAfterFirst).toBe(0);
    store.set(terminalSessionStateAtom, 'attached');

    const second = makeChoice(session);
    second.attachInfo.connection_token = 'tok2'; // fresh token per dialog confirm
    store.set(attachToSessionAtom, { session, choice: second, navigate });
    expect(store.get(routeIntentEpochAtom)).toBe(epochAfterFirst + 1);
    expect(store.get(attachInfoAtom)?.connection_token).toBe('tok2');
  });

  it('attachToSessionAtom does not bump the route intent when attaching a different session', () => {
    // A different session changes sessionIdAtom, which releases the old
    // runtime and creates a fresh one from phase 'idle' — no route-intent
    // bump needed, and keeping the epoch stable keeps transport keys tidy.
    const store = createStore();
    const session = makeSession();
    store.set(attachToSessionAtom, { session, choice: makeChoice(session), navigate });
    const epochAfterFirst = store.get(routeIntentEpochAtom);

    const other = makeSession();
    other.session_id = 'agent:other';
    other.session_name = 'other';
    store.set(attachToSessionAtom, { session: other, choice: makeChoice(other), navigate });
    expect(store.get(sessionIdAtom)).toBe('agent:other');
    expect(store.get(routeIntentEpochAtom)).toBe(epochAfterFirst);
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
    const epochAfterFirst = store.get(routeIntentEpochAtom);
    expect(epochAfterFirst).toBe(1);

    // Simulate connection having come up since the first switch — so the
    // second switch has a non-idle state to preserve.
    store.set(terminalSessionStateAtom, 'attached');

    // Second switch with the same URL must NOT tear down the connection
    // (would otherwise flash a spinner for a logical no-op).
    store.set(switchAddressAtom, 'ws://same/ws');
    expect(store.get(manualOverrideAtom)).toBe('ws://same/ws');
    expect(store.get(routeIntentEpochAtom)).toBe(epochAfterFirst); // epoch unchanged
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
    expect(store.get(routeIntentEpochAtom)).toBe(1);
  });

  it('switchAddressAtom is a no-op when re-selecting Auto (null → null)', () => {
    const store = createStore();
    // Start in Auto mode (manualOverride is null).
    expect(store.get(manualOverrideAtom)).toBeNull();
    const epochInitial = store.get(routeIntentEpochAtom);
    expect(epochInitial).toBe(0);

    // Simulate connection having come up.
    store.set(terminalSessionStateAtom, 'attached');

    // Re-selecting Auto must NOT tear down the connection — would otherwise
    // flash a spinner every time the user clicks the Auto entry they're
    // already on, and is the reported cause of "selecting auto multiple
    // times → no content".
    store.set(switchAddressAtom, null);
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(routeIntentEpochAtom)).toBe(epochInitial); // epoch unchanged
    expect(store.get(terminalSessionStateAtom)).toBe('attached'); // state preserved
  });

  it('switchAddressAtom is a no-op when explicit → Auto resolves to same URL', () => {
    const store = createStore();
    const session = makeSession();
    store.set(attachToSessionAtom, { session, choice: makeChoice(session), navigate });
    store.set(switchAddressAtom, 'ws://a/ws');
    const epochAfterExplicit = store.get(routeIntentEpochAtom);
    store.set(terminalSessionStateAtom, 'attached');

    store.set(switchAddressAtom, null);
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(routeIntentEpochAtom)).toBe(epochAfterExplicit);
    expect(store.get(terminalSessionStateAtom)).toBe('attached');
  });

  it('switchAddressAtom reconnects when explicit → Auto picks a different URL', () => {
    const store = createStore();
    const session = makeSession();
    const choice = makeChoice(session);
    choice.orderedUrls = ['ws://best/ws'];
    store.set(attachToSessionAtom, { session, choice, navigate });
    store.set(switchAddressAtom, 'ws://slow/ws');
    const epochAfterExplicit = store.get(routeIntentEpochAtom);

    store.set(switchAddressAtom, null);
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(routeIntentEpochAtom)).toBe(epochAfterExplicit + 1);
  });

  it('switchAddressAtom reconnects when failed manual → Auto resolves to same URL', () => {
    const store = createStore();
    const session = makeSession();
    store.set(attachToSessionAtom, { session, choice: makeChoice(session), navigate });
    store.set(switchAddressAtom, 'ws://a/ws');
    const epochAfterExplicit = store.get(routeIntentEpochAtom);
    store.set(terminalSessionStateAtom, 'failed');

    store.set(switchAddressAtom, null);
    expect(store.get(manualOverrideAtom)).toBeNull();
    expect(store.get(routeIntentEpochAtom)).toBe(epochAfterExplicit + 1);
  });
});

describe('attachDialogIntentAtom', () => {
  it('defaults to attach', () => {
    const store = createStore();
    expect(store.get(attachDialogIntentAtom)).toBe('attach');
  });

  it('resets to attach when attachToSessionAtom confirms', () => {
    const store = createStore();
    const session = makeSession();
    store.set(attachDialogSessionAtom, session);
    store.set(attachDialogIntentAtom, 'configure');
    store.set(attachToSessionAtom, { session, choice: makeChoice(session), navigate });
    expect(store.get(attachDialogIntentAtom)).toBe('attach');
    expect(store.get(attachDialogSessionAtom)).toBeNull();
  });

  it('resets to attach on disconnect', () => {
    const store = createStore();
    const session = makeSession();
    store.set(attachDialogSessionAtom, session);
    store.set(attachDialogIntentAtom, 'configure');
    store.set(disconnectAtom, navigate);
    expect(store.get(attachDialogIntentAtom)).toBe('attach');
    expect(store.get(attachDialogSessionAtom)).toBeNull();
  });
});
