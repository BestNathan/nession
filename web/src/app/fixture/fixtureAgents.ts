import { FIXTURE_AGENTS } from './fixtureData';
import type { Agent } from '@/types';

/**
 * The Agent set a canonical fixture route advertises (#1083 §9).
 *
 *   /#/fixture/app               → the canonical route: two online, one offline
 *   /#/fixture/app?agents=offline → the server reports every Agent offline
 *
 * The "no online Agent" state had no route either, and it is the one state
 * where creation cannot succeed — so it is the state where the App has to say
 * *why* the control is unavailable. Without a route it could not be captured,
 * and a rendering nobody can produce is a rendering nobody has checked.
 *
 * It names the input — what the server reported about its Agents — rather than
 * asking for the rendering, on the line `fixtureStaleAgents` draws. It flips
 * `status` and nothing else: the Agents are still advertised, still listed, and
 * still hold their Sessions, because an Agent being offline does not remove it
 * from the product's model (`session-list.md`: never drop Sessions whose
 * location is unreachable). A route that removed them instead would be
 * modelling a different input than the product has.
 *
 * Absent, or anything other than `offline`, is the canonical route, so the
 * existing golden screenshots do not move.
 */
export function fixtureAgents(search: string): Agent[] {
  return new URLSearchParams(search).get('agents') === 'offline'
    ? FIXTURE_AGENTS.map((agent) => ({ ...agent, status: 'offline' as const }))
    : FIXTURE_AGENTS;
}
