import { FIXTURE_SESSIONS } from './fixtureData';
import { PROJECT_ONE, PROJECT_TWO } from './fixtureProjects';
import type { Session } from '@/types';

export type FixtureSessionProjectScenario =
  | 'unbound'
  | 'bound'
  | 'bound-ab'
  | 'bound-offline'
  | 'deleted';

/** The focused-Session Project input a fixture route advertises (#3082). */
export function fixtureSessionProjectScenario(
  search: string,
): FixtureSessionProjectScenario {
  const value = new URLSearchParams(search).get('sessionProject');
  if (
    value === 'bound' ||
    value === 'bound-ab' ||
    value === 'bound-offline' ||
    value === 'deleted'
  ) {
    return value;
  }
  return 'unbound';
}

/**
 * Initial Session→Project bindings for a fixture route.
 *
 * Canonical routes are unbound so existing goldens and capability entries do
 * not move. `deleted` deliberately names a Project the fixture list does not
 * contain, so the capability can be tested for a safe unavailable state.
 */
export function fixtureSessionBindings(
  search: string,
): Record<string, string | null> {
  switch (fixtureSessionProjectScenario(search)) {
    case 'bound':
      return {
        'devbox-01:fix-terminal-reconnect': PROJECT_ONE,
        'devbox-01:staging-deploy': PROJECT_ONE,
      };
    case 'bound-ab':
      return {
        'devbox-01:fix-terminal-reconnect': PROJECT_ONE,
        'devbox-01:design-system': PROJECT_TWO,
      };
    case 'bound-offline':
      return { 'sg-prod:prod-shell': PROJECT_ONE };
    case 'deleted':
      return { 'devbox-01:fix-terminal-reconnect': 'project-00000000-0000-4000-8000-000000000099' };
    case 'unbound':
      return {};
  }
}

/**
 * The revision generation behind each initial membership (#4234).
 *
 * A bound Session starts at revision 1; `0` is the unassociated token. The
 * fixture advances this generation monotonically across remove/reassociate so
 * a stale editor is exercised exactly like the Server's CAS.
 */
export function fixtureSessionProjectRevisions(search: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(fixtureSessionBindings(search)).map(([sessionId, projectId]) => [
      sessionId,
      projectId === null ? 0 : 1,
    ]),
  );
}

/**
 * Overlay the fixture's current membership and revision on its Session set.
 *
 * Every Session carries `project_revision`: an unassociated one reports the
 * `0` token, mirroring the Server read model (#4234).
 */
export function applySessionProjectBindings(
  sessions: Session[],
  bindings: Record<string, string | null>,
  revisions: Record<string, number>,
): Session[] {
  return sessions.map((session) => {
    const bound = Object.prototype.hasOwnProperty.call(bindings, session.session_id);
    const projectId = bound ? bindings[session.session_id] : (session.project_id ?? null);
    return {
      ...session,
      ...(bound ? { project_id: projectId } : {}),
      project_revision:
        projectId === null ? 0 : (revisions[session.session_id] ?? session.project_revision ?? 1),
    };
  });
}

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
