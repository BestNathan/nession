import type { ConnectionState } from '@/platform/socket/types';

/**
 * The server-link state a canonical fixture route advertises (#1083 §8).
 *
 *   /#/fixture/app                    → the canonical route: connected
 *   /#/fixture/app?connection=reconnecting → the link is coming back
 *   /#/fixture/app?connection=disconnected → it is not
 *
 * The App's degraded region had no route that could produce it — both fixture
 * frames hardcoded `'connected'` — so "healthy infrastructure is invisible;
 * degraded infrastructure is contextual" was checkable in one direction only.
 * The half that renders something had never been photographed, which is the
 * same gap `?sessions=none` closed for the empty states.
 *
 * It names the input — what the socket is doing — rather than asking for the
 * banner, on the line the other fixture parameters draw. Only the two degraded
 * states are settable: `connecting` is a transient the product spends a moment
 * in and no screen is about, and `connected` is the canonical route, so
 * spelling it out would be a second way to ask for the default.
 *
 * Absent, or any other value, is the canonical route, so the existing golden
 * screenshots do not move.
 */
export function fixtureConnection(search: string): ConnectionState {
  const value = new URLSearchParams(search).get('connection');
  return value === 'reconnecting' || value === 'disconnected'
    ? value
    : 'connected';
}
