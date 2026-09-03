import { describe, it, expect } from 'vitest';
import { AttachStateMachine, P2P_MAX_RECONNECT } from '@/runtime/AttachStateMachine';

describe('AttachStateMachine extra coverage', () => {
  it('P2P_CONNECTED promotes legacy transport path to connected', () => {
    const sm = new AttachStateMachine({ transportFirst: false });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    sm.dispatch({ type: 'P2P_CONNECTED' });
    expect(sm.phase).toBe('connected');
  });

  it('canStartAttach requires transport ready in transport-first mode', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    expect(sm.canStartAttach(false, true, false, 'p2p')).toBe(false);
    expect(sm.canStartAttach(true, true, false, 'p2p')).toBe(true);
  });

  it('canStartAttach for relay requires server ready', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    expect(sm.canStartAttach(true, false, false, 'relay')).toBe(false);
    expect(sm.canStartAttach(true, false, true, 'relay')).toBe(true);
  });

  it('ATTACH_TIMEOUT toggles reconnecting before budget exhausted', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const first = sm.dispatch({ type: 'ATTACH_TIMEOUT', manualRoute: false, attempt: 1 });
    expect(first.phase).toBe('reconnecting');
    expect(first.reconnectCount).toBe(1);
  });

  it('ATTACH_TIMEOUT after budget falls back to relay', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const result = sm.dispatch({
      type: 'ATTACH_TIMEOUT',
      manualRoute: false,
      attempt: P2P_MAX_RECONNECT + 1,
    });
    expect(result.phase).toBe('connecting');
    expect(result.forceRelay).toBe(true);
    expect(result.bumpRouteEpoch).toBe(true);
  });


  it('ATTACH_TIMEOUT within budget marks the outcome retryable (manual and auto)', () => {
    for (const manualRoute of [false, true]) {
      const sm = new AttachStateMachine({ transportFirst: true });
      sm.dispatch({ type: 'SESSION_SELECTED' });
      const first = sm.dispatch({ type: 'ATTACH_TIMEOUT', manualRoute, attempt: 1 });
      expect(first.retryAttach).toBe(true);
      const nearLimit = sm.dispatch({ type: 'ATTACH_TIMEOUT', manualRoute, attempt: P2P_MAX_RECONNECT });
      expect(nearLimit.retryAttach).toBe(true);
    }
  });

  it('ATTACH_TIMEOUT past budget is not retryable', () => {
    const auto = new AttachStateMachine({ transportFirst: true });
    auto.dispatch({ type: 'SESSION_SELECTED' });
    const autoResult = auto.dispatch({
      type: 'ATTACH_TIMEOUT',
      manualRoute: false,
      attempt: P2P_MAX_RECONNECT + 1,
    });
    expect(autoResult.retryAttach).toBe(false);
    expect(autoResult.forceRelay).toBe(true);

    const manual = new AttachStateMachine({ transportFirst: true });
    manual.dispatch({ type: 'SESSION_SELECTED' });
    const manualResult = manual.dispatch({
      type: 'ATTACH_TIMEOUT',
      manualRoute: true,
      attempt: P2P_MAX_RECONNECT + 1,
    });
    expect(manualResult.retryAttach).toBe(false);
    expect(manualResult.phase).toBe('failed');
  });

  it('DISCONNECT resets to idle', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    sm.dispatch({ type: 'ATTACH_OK' });
    const result = sm.dispatch({ type: 'DISCONNECT' });
    expect(result.phase).toBe('idle');
    expect(result.reconnectCount).toBe(0);
  });
});
