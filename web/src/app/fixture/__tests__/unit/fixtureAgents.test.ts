import { describe, expect, it } from 'vitest';
import { FIXTURE_AGENTS } from '../../fixtureData';
import { fixtureAgents } from '../../fixtureAgents';

describe('fixtureAgents', () => {
  it('keeps the canonical fleet for an absent or unknown route', () => {
    expect(fixtureAgents('')).toBe(FIXTURE_AGENTS);
    expect(fixtureAgents('?agents=other')).toBe(FIXTURE_AGENTS);
  });

  it('reports every canonical Agent offline without removing any', () => {
    const agents = fixtureAgents('?agents=offline');
    expect(agents).toHaveLength(FIXTURE_AGENTS.length);
    expect(agents.every((agent) => agent.status === 'offline')).toBe(true);
  });

  it('advertises a larger reachable online fleet for the many route', () => {
    const agents = fixtureAgents('?agents=many');
    expect(agents).toHaveLength(23);
    expect(agents.slice(0, FIXTURE_AGENTS.length)).toEqual(FIXTURE_AGENTS);
    const ids = new Set(agents.map((agent) => agent.agent_id));
    expect(ids.size).toBe(agents.length);
    expect(agents.slice(FIXTURE_AGENTS.length).every((agent) => agent.status === 'online'))
      .toBe(true);
  });
});
