// web/src/terminal/state/__tests__/session.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { sessionIdAtom, sessionNameAtom, attachInfoAtom } from '@/atoms/session';
import { terminalSessionAtom, terminalSessionStateAtom } from '@/terminal/state/session';
import { terminalViewModelAtomFamily } from '@/terminal/state/index';

describe('terminalSessionAtom', () => {
  it('is null when no session is attached', () => {
    const store = createStore();
    expect(store.get(terminalSessionAtom)).toBeNull();
  });

  it('derives from the global session atoms', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    store.set(sessionNameAtom, 'sess');
    store.set(terminalSessionStateAtom, 'attached');
    store.set(attachInfoAtom, { mode: 'p2p', session_id: 'agent:sess' });

    const session = store.get(terminalSessionAtom);
    expect(session).not.toBeNull();
    expect(session?.id).toBe('agent:sess');
    expect(session?.name).toBe('sess');
    expect(session?.status).toBe('attached');
    expect(session?.mode).toBe('p2p');
    expect(typeof session?.startedAt).toBe('number');
  });

  it('reflects relay mode when no p2p attach info is present', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    expect(store.get(terminalSessionAtom)?.mode).toBe('relay');
  });

  it('writing with no args stamps a stable startedAt', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    const before = Date.now();
    store.set(terminalSessionAtom);
    const session = store.get(terminalSessionAtom);
    expect(session?.startedAt).toBeGreaterThanOrEqual(before);
    expect(session?.startedAt).toBeLessThanOrEqual(Date.now());
    // Stable across subsequent reads
    expect(store.get(terminalSessionAtom)?.startedAt).toBe(session?.startedAt);
  });

  it('startedAt does not drift across state transitions', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    store.set(terminalSessionStateAtom, 'idle');

    // Not formally started — pinned atom is still 0, no Date.now() fallback.
    const initial = store.get(terminalSessionAtom);
    expect(initial?.startedAt).toBe(0);

    // Transition through states without writing the stamp action.
    store.set(terminalSessionStateAtom, 'connecting');
    const connecting = store.get(terminalSessionAtom);
    store.set(terminalSessionStateAtom, 'connected');
    const connected = store.get(terminalSessionAtom);

    expect(connecting?.startedAt).toBe(initial?.startedAt);
    expect(connected?.startedAt).toBe(initial?.startedAt);

    // Once stamped by the write action, it stays pinned across transitions too.
    store.set(terminalSessionAtom);
    const stamped = store.get(terminalSessionAtom)?.startedAt;
    store.set(terminalSessionStateAtom, 'reconnecting');
    store.set(terminalSessionStateAtom, 'failed');
    expect(store.get(terminalSessionAtom)?.startedAt).toBe(stamped);
  });
});

describe('terminalViewModelAtomFamily', () => {
  it('aggregates session, size, mode, focused, capabilities, banner', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    store.set(terminalSessionStateAtom, 'connected');

    const vm = store.get(terminalViewModelAtomFamily('agent:sess'));
    expect(vm.session?.id).toBe('agent:sess');
    expect(vm.session?.status).toBe('connected');
    expect(vm.size).toEqual({ cols: 80, rows: 24 });
    expect(vm.mode).toEqual({ type: 'terminal' });
    expect(vm.focused).toBe(false);
    expect(vm.capabilities.clipboard).toBe(true);
    expect(vm.banner).toBe('none');
  });
});
