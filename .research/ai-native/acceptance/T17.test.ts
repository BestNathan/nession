import { describe, expect, it } from 'vitest';
import { AttachStateMachine } from '@/platform/attach/AttachStateMachine';

describe('research acceptance T17', () => {
  it('manual transport exhaustion remains failed and never asks for relay', () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const result = sm.dispatch({ type: 'TRANSPORT_EXHAUSTED', manualRoute: true });

    expect(result.phase).toBe('failed');
    expect(result.forceRelay).toBe(false);
  });
});
