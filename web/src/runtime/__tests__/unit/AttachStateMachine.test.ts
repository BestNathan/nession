import { describe, it, expect } from 'vitest';
import { AttachStateMachine, P2P_MAX_RECONNECT } from '@/runtime/AttachStateMachine';

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
    expect(result.bumpRouteEpoch).toBe(true);
    expect(result.phase).toBe('connecting');
  });

  it('ATTACH_OK reaches attached', () => {
    const sm = new AttachStateMachine({ transportFirst: false });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    sm.dispatch({ type: 'ATTACH_OK' });
    expect(sm.phase).toBe('attached');
  });
});
