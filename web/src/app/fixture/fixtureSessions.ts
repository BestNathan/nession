import { FIXTURE_SESSIONS } from './fixtureData';
import type { Session } from '@/types';

/**
 * The Session set a canonical fixture route advertises (#1083 §9).
 *
 *   /#/fixture/app              → the canonical route: six Sessions
 *   /#/fixture/app?sessions=none → the server reports none
 *
 * The App's empty state had no route that could produce it. `?selection=none`
 * looks like it should — but it only deselects, and the list still holds six
 * rows, so "no Sessions" was unreachable from every canonical screen and the
 * visual gate had nothing to protect. This is the input that was missing.
 *
 * It names the *input* — what the server answered — rather than asking for a
 * rendering, on the line `fixtureStaleAgents` and `fixtureSelection` draw: a
 * route that could ask for "the empty state" directly would let a test assert a
 * rendering the app never decided on.
 *
 * Absent, or anything other than `none`, is the canonical route, so the
 * existing golden screenshots do not move. `none` is deliberately the only
 * meaningful value: the state under test is *zero* Sessions, and a route that
 * could name an arbitrary subset would be a filter, which the product already
 * has (`useDashboard.filterSessions`) and which the fixture already expresses
 * through `statusFilter` and the search field.
 */
export function fixtureSessions(search: string): Session[] {
  return new URLSearchParams(search).get('sessions') === 'none'
    ? []
    : FIXTURE_SESSIONS;
}
