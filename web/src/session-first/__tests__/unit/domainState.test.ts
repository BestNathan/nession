import { describe, it, expect } from 'vitest';
import type { Agent, Session } from '@/types';
import { mapDomainState } from '@/session-first/domainState';

function agent(over: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1', hostname: 'devbox-01', ip_address: '10.0.0.1', port: 1,
    status: 'online', session_count: 1, last_heartbeat: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    session_id: 'a1:s1', agent_id: 'a1', session_name: 's1', status: 'active',
    window_count: 1, attached_clients: 0, last_activity: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('mapDomainState', () => {
  it('maps online agent + unmatched row to quiet agent, active session, detached', () => {
    const d = mapDomainState({
      session: session(), agent: agent(), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.channel).toBe('online');
    expect(d.agent.copy).toBeNull();
    expect(d.session.channel).toBe('active');
    expect(d.attachment.channel).toBe('detached');
  });

  it('maps wire detached to session.active (tmux still exists)', () => {
    const d = mapDomainState({
      session: session({ status: 'detached' }), agent: agent(), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.session.channel).toBe('active');
  });

  it('maps zombie to session.exited', () => {
    const d = mapDomainState({
      session: session({ status: 'zombie' }), agent: agent(), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.session.channel).toBe('exited');
  });

  it('maps offline agent with listed session — Agent copy, not Session offline', () => {
    const d = mapDomainState({
      session: session(), agent: agent({ status: 'offline' }), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.channel).toBe('offline');
    expect(d.agent.copy).toMatch(/Agent (offline|unreachable)/);
    expect(d.session.channel).toBe('active');
    expect(d.agent.copy).not.toMatch(/Session offline/i);
  });

  it('stale_agents marks unhealthy even when agent.status is online', () => {
    const d = mapDomainState({
      session: session(), agent: agent({ status: 'online' }), staleAgentIds: ['a1'],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.copy).toBe('Agent did not respond');
    expect(d.session.channel).toBe('active');
  });

  it('degraded maps to agent.error', () => {
    const d = mapDomainState({
      session: session(), agent: agent({ status: 'degraded' }), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.channel).toBe('error');
    expect(d.agent.copy).toBe('Agent error');
  });

  it('missing agent → unreachable + session.unknown', () => {
    const d = mapDomainState({
      session: session(), agent: undefined, staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.channel).toBe('offline');
    expect(d.session.channel).toBe('unknown');
  });

  it('this-client attached / attaching / failed', () => {
    const base = {
      session: session(), agent: agent(), staleAgentIds: [] as string[],
    };
    expect(mapDomainState({
      ...base, clientSessionId: 'a1:s1', attachInFlightId: null, attachFailedId: null,
    }).attachment.channel).toBe('attached');
    expect(mapDomainState({
      ...base, clientSessionId: '', attachInFlightId: 'a1:s1', attachFailedId: null,
    }).attachment.channel).toBe('attaching');
    expect(mapDomainState({
      ...base, clientSessionId: '', attachInFlightId: null, attachFailedId: 'a1:s1',
    }).attachment.channel).toBe('failed');
  });
});
