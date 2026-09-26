import { FIXTURE_SELECTED_ID } from './fixtureData';

/**
 * The Session-selection input a canonical fixture route can express (#1082).
 *
 *   /#/fixture/app                → the canonical route: a Session is selected
 *   /#/fixture/app?selection=none → nothing is selected
 *
 * The no-Session App root is a screen in its own right now, and it had no route
 * that could produce it — the fixture always had a Session, so the home was
 * unreachable from every canonical screen and the visual gate had nothing to
 * protect. The parameter names the state rather than asking for a rendering, on
 * the same line `fixtureStaleAgents` draws.
 *
 * Absent, or anything other than `none`, is the canonical route — so the
 * existing golden screenshots do not move. `none` is deliberately the only
 * meaningful value: a route that could name an arbitrary Session would let a
 * test assert a selection the product never made, and there is no second
 * Session worth selecting in `FIXTURE_SESSIONS` anyway.
 */
export function fixtureSelectedId(search: string): string | null {
  return new URLSearchParams(search).get('selection') === 'none'
    ? null
    : FIXTURE_SELECTED_ID;
}
