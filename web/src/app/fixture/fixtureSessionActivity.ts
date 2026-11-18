import type { Session, SessionActivity } from '@/types';

/**
 * The Session Activity the fixture route advertises (#3804).
 *
 *   /#/fixture/app                       → no reported Activity (legacy/unknown)
 *   /#/fixture/app?sessionActivity=canonical → four distinct readings at once
 *
 * This is an **input** — what the Agents' coordinators reported — not a
 * requested rendering, on the line `fixtureAgents` and `fixtureStaleAgents`
 * draw. The product decides how the level is rendered, and how an offline or
 * stale Agent invalidates it.
 *
 * The canonical set deliberately spans every outcome so one screen proves they
 * are distinguishable:
 *
 * - `fix-terminal-reconnect` working (shell);
 * - `design-system` working + `input_required` (Claude Code);
 * - `staging-deploy` idle;
 * - `review-pr-561` has no reported level → explicit unknown;
 * - `prod-shell` reports working but its Agent is offline → the row must read
 *   unknown, not the last level.
 *
 * Any other value, including absent, reports nothing: existing goldens and
 * capability entries stay on the legacy path.
 */
export function fixtureSessionActivity(search: string): Record<string, SessionActivity> {
  const scenario = new URLSearchParams(search).get('sessionActivity');
  if (scenario === 'alternate') {
    // The same Sessions with different levels: a route transition that only
    // Activity changes, for asserting recency/order/identity do not move.
    return {
      'devbox-01:fix-terminal-reconnect': {
        state: 'idle',
        attention: null,
        capability_id: 'shell',
        observed_at_ms: 1_756_713_700_000,
      },
      'devbox-01:design-system': {
        state: 'unknown',
        attention: null,
        capability_id: null,
        observed_at_ms: 1_756_713_700_000,
      },
      'devbox-01:staging-deploy': {
        state: 'working',
        attention: null,
        capability_id: 'shell',
        observed_at_ms: 1_756_713_700_000,
      },
      'macbook:review-pr-561': {
        state: 'idle',
        attention: null,
        capability_id: 'claude-code',
        observed_at_ms: 1_756_713_700_000,
      },
      'sg-prod:prod-shell': {
        state: 'working',
        attention: null,
        capability_id: 'shell',
        observed_at_ms: 1_756_713_700_000,
      },
    };
  }
  if (scenario !== 'canonical') {
    return {};
  }
  return {
    'devbox-01:fix-terminal-reconnect': {
      state: 'working',
      attention: null,
      capability_id: 'shell',
      observed_at_ms: 1_756_713_600_000,
    },
    'devbox-01:design-system': {
      state: 'working',
      attention: 'input_required',
      capability_id: 'claude-code',
      observed_at_ms: 1_756_713_600_000,
    },
    'devbox-01:staging-deploy': {
      state: 'idle',
      attention: null,
      capability_id: 'shell',
      observed_at_ms: 1_756_713_600_000,
    },
    'macbook:dotfiles': {
      state: 'idle',
      attention: null,
      capability_id: 'shell',
      observed_at_ms: 1_756_713_600_000,
    },
    'sg-prod:prod-shell': {
      state: 'working',
      attention: null,
      capability_id: 'shell',
      observed_at_ms: 1_756_713_600_000,
    },
  };
}

/** Overlay reported Activity on the Session set, leaving unreported rows absent. */
export function applySessionActivity(
  sessions: Session[],
  activity: Record<string, SessionActivity>,
): Session[] {
  return sessions.map((session) =>
    Object.prototype.hasOwnProperty.call(activity, session.session_id)
      ? { ...session, activity: activity[session.session_id] }
      : session,
  );
}
