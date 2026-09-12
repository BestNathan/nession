import { describe, expect, it } from 'vitest';
import { resolveSessionChrome } from '../../sessionChrome';
import type { DomainState } from '../../domainState';

function state(overrides: {
  agent?: DomainState['agent']['channel'];
  session?: DomainState['session']['channel'];
  attachment?: DomainState['attachment']['channel'];
}): DomainState {
  return {
    agent: { channel: overrides.agent ?? 'online', copy: null },
    session: { channel: overrides.session ?? 'active', copy: null },
    attachment: { channel: overrides.attachment ?? 'attached', copy: null },
  };
}

describe('session chrome presence policy', () => {
  it('keeps every infrastructure member quiet while the session is healthy', () => {
    const chrome = resolveSessionChrome(state({}));
    expect(chrome.agent).toBe('quiet');
    expect(chrome.connection).toBe('quiet');
  });

  it('escalates an unreachable agent', () => {
    expect(resolveSessionChrome(state({ agent: 'offline' })).agent).toBe('prominent');
    expect(resolveSessionChrome(state({ agent: 'error' })).agent).toBe('prominent');
  });

  it('escalates when the session is gone', () => {
    expect(resolveSessionChrome(state({ session: 'exited' })).connection).toBe('prominent');
  });

  it('escalates a failed attachment', () => {
    expect(resolveSessionChrome(state({ attachment: 'failed' })).connection).toBe('prominent');
  });

  it('shows an attachment that is still in flight without escalating it', () => {
    expect(resolveSessionChrome(state({ attachment: 'attaching' })).connection).toBe('present');
  });

  it('treats a detached session as quiet — not attached is the resting state', () => {
    expect(resolveSessionChrome(state({ attachment: 'detached' })).connection).toBe('quiet');
  });

  it('keeps the agent visible when only the session dimension is unknown', () => {
    // An unknown session means there is no agent to ask; the agent member
    // already carries that escalation, so it must not double up.
    const chrome = resolveSessionChrome(state({ agent: 'offline', session: 'unknown' }));
    expect(chrome.agent).toBe('prominent');
    expect(chrome.connection).toBe('quiet');
  });
});
