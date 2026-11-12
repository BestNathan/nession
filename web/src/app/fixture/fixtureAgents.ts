import { FIXTURE_AGENTS } from './fixtureData';
import type { Agent } from '@/types';

/**
 * The Agent set a canonical fixture route advertises (#1083 §9).
 *
 *   /#/fixture/app               → the canonical route: two online, one offline
 *   /#/fixture/app?agents=offline → the server reports every Agent offline
 *   /#/fixture/app?agents=many    → a reachable larger fleet (23 Agents)
 *
 * The "no online Agent" state had no route either, and it is the one state
 * where creation cannot succeed — so it is the state where the App has to say
 * *why* the control is unavailable. Without a route it could not be captured,
 * and a rendering nobody can produce is a rendering nobody has checked.
 *
 * `many` exists so an anchored choice can be proven against its available
 * height with more rows than a viewport holds. The extra Agents are ordinary
 * online nodes; the route changes only the advertised population.
 *
 * It names the input — what the server reported about its Agents — rather than
 * asking for the rendering, on the line `fixtureStaleAgents` draws. The
 * offline scenario flips `status` and nothing else: the Agents are still
 * advertised, still listed, and still hold their Sessions, because an Agent
 * being offline does not remove it from the product's model (`session-list.md`:
 * never drop Sessions whose location is unreachable). A route that removed them
 * instead would be modelling a different input than the product has.
 *
 * Absent, or anything other than `offline`/`many`, is the canonical route, so
 * the existing golden screenshots do not move.
 */
function manyAgents(): Agent[] {
  return Array.from({ length: 20 }, (_, index) => {
    const ordinal = index + 1;
    return {
      ...FIXTURE_AGENTS[0],
      agent_id: `scale-${ordinal}`,
      hostname: `scale-${ordinal}`,
      display_name: `Scale Agent ${ordinal}`,
      ip_address: `10.0.1.${ordinal}`,
      port: 19091,
      status: 'online' as const,
      session_count: 0,
    };
  });
}

export function fixtureAgents(search: string): Agent[] {
  const scenario = new URLSearchParams(search).get('agents');
  if (scenario === 'offline') {
    return FIXTURE_AGENTS.map((agent) => ({ ...agent, status: 'offline' as const }));
  }
  if (scenario === 'many') {
    return [...FIXTURE_AGENTS, ...manyAgents()];
  }
  return FIXTURE_AGENTS;
}
