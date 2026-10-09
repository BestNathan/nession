import { describe, it, expect } from 'vitest';
import { AttachStateMachine, P2P_MAX_RECONNECT } from '@/platform/attach/AttachStateMachine';

describe('AttachStateMachine', () => {
  it('starts connecting on SESSION_SELECTED', () => {
    const sm = new AttachStateMachine({ transportFirst: false });
    const result = sm.dispatch({ type: 'SESSION_SELECTED' });
    expect(result.phase).toBe('connecting');
    expect(result.reconnectCount).toBe(0);
  });

  it('legacy path moves to connected on P2P_CONNECTED', () => {
    const sm = new AttachStateMachine({ transportFirst: false });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    sm.dispatch({ type: 'P2P_CONNECTED' });
    expect(sm.phase).toBe('connected');
  });

  it('transport-first waits for TRANSPORT_READY before attach eligibility', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    sm.dispatch({ type: 'P2P_CONNECTED' });
    expect(sm.canStartAttach(false, true, false, 'p2p')).toBe(false);
    sm.dispatch({ type: 'TRANSPORT_READY' });
    expect(sm.canStartAttach(true, true, false, 'p2p')).toBe(true);
  });

  it('ATTACH_TIMEOUT forces relay after budget on auto route', () => {
    const sm = new AttachStateMachine({ transportFirst: false });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const result = sm.dispatch({
      type: 'ATTACH_TIMEOUT',
      manualRoute: false,
      attempt: P2P_MAX_RECONNECT + 1,
    });
    expect(result.forceRelay).toBe(true);
    expect(result.phase).toBe('connecting');
  });

  it('TRANSPORT_EXHAUSTED fails on manual route', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const result = sm.dispatch({ type: 'TRANSPORT_EXHAUSTED', manualRoute: true });
    expect(result.phase).toBe('failed');
  });

  it('leaves failed when the transport connects again', () => {
    // `failed` claims the route is spent, so a connection disproves it. A pinned
    // route that was reported exhausted and then came back must not leave the
    // shell saying "Attach failed" over a live connection.
    const viaP2p = new AttachStateMachine({ transportFirst: false });
    viaP2p.dispatch({ type: 'SESSION_SELECTED' });
    viaP2p.dispatch({ type: 'TRANSPORT_EXHAUSTED', manualRoute: true });
    expect(viaP2p.phase).toBe('failed');
    expect(viaP2p.dispatch({ type: 'P2P_CONNECTED' }).phase).toBe('connected');
    viaP2p.dispatch({ type: 'ATTACH_OK' });
    expect(viaP2p.phase).toBe('attached');

    // Transport-first keeps the phase word where that experience puts it — the
    // transport gates the attach instead of being reported as the connection —
    // so what has to hold is that the attach may start again (`canStartAttach`,
    // which has always accepted `failed`) and that the attach itself clears it.
    const viaTransport = new AttachStateMachine({ transportFirst: true });
    viaTransport.dispatch({ type: 'SESSION_SELECTED' });
    viaTransport.dispatch({ type: 'TRANSPORT_EXHAUSTED', manualRoute: true });
    expect(viaTransport.phase).toBe('failed');
    viaTransport.dispatch({ type: 'TRANSPORT_READY' });
    expect(viaTransport.canStartAttach(true, true, false, 'p2p')).toBe(true);
    viaTransport.dispatch({ type: 'ATTACH_OK' });
    expect(viaTransport.phase).toBe('attached');
  });

  it('ATTACH_OK reaches attached', () => {
    const sm = new AttachStateMachine({ transportFirst: false });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    sm.dispatch({ type: 'ATTACH_OK' });
    expect(sm.phase).toBe('attached');
  });
});
