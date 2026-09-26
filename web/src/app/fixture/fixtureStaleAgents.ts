import { FIXTURE_AGENTS } from './fixtureData';

/**
 * The Session-list input a canonical fixture route can express: which Agents
 * failed to answer the last force refresh.
 *
 * Staleness is not a property of an Agent — it is the Server's answer about
 * what happened when it asked one (`session.stale_agents`, carried to the UI as
 * `staleAgents` by `useSessionData`). The fixture has no transport, so nothing
 * the route does can produce it: a Session on a listed Agent simply looks
 * healthy. The parameter names that *input* rather than the reading it
 * resolves to, which is the same line `fixtureCapabilityFacts` and
 * `fixtureGitSurface` draw — a route that could ask for "the degraded row"
 * directly would let a test assert a rendering the app never decided on.
 *
 *   /#/fixture/app?stale=macbook → macbook was listed, and the refresh that
 *                                  followed got no answer from it
 *
 * The ids are filtered against `FIXTURE_AGENTS`: the Server reports staleness
 * for Agents it knows, so an id that names none is not an input the product can
 * be handed, and letting one through would put a Session into a state nothing
 * else could explain.
 *
 * Absent (or entirely unknown) means "no stale Agents", which is the untouched
 * canonical route — so the golden screenshots do not move.
 */
export function fixtureStaleAgents(search: string): string[] {
  const known = new Set(FIXTURE_AGENTS.map((agent) => agent.agent_id));
  return (new URLSearchParams(search).get('stale') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => known.has(id));
}
