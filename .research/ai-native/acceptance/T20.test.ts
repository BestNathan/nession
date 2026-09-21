import { describe, expect, it } from 'vitest';
import { AttachStateMachine } from '@/platform/attach/AttachStateMachine';

describe('research acceptance T20', () => {
  it('returns one explicit discriminated recovery action', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });

    const result = sm.dispatch({
      type: 'ATTACH_TIMEOUT',
      manualRoute: false,
      attempt: 1,
    }) as unknown as Record<string, unknown>;

    expect(result.action).toEqual({ type: 'retry-attach' });
    expect('forceRelay' in result).toBe(false);
    expect('bumpRouteEpoch' in result).toBe(false);
    expect('retryAttach' in result).toBe(false);
  });
});
