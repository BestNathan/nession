import type { DomainState } from './domainState';

/**
 * How strongly a Session chrome member should present itself.
 *
 * `quiet` means the member carries no information the user needs right now and
 * must not occupy space. Severity is a separate axis: the members that do
 * render keep their existing tone.
 */
export type SessionChromePresence = 'quiet' | 'present' | 'prominent';

export interface SessionChrome {
  /** Agent / location context. */
  agent: SessionChromePresence;
  /** Session + attachment continuity (session lifecycle, attach state). */
  connection: SessionChromePresence;
}

/**
 * Nession-owned Session chrome policy.
 *
 * Session-level chrome is quiet while everything is healthy and escalates with
 * impact — an unreachable agent, a gone session, or a failed attach all block
 * the current work and must stay visible and recoverable. Healthy redundancy
 * (`online`, `active`, `attached`, `detached`) is not worth permanent space:
 * the session list already carries the location, and the terminal surface owns
 * its own attach affordances.
 */
export function resolveSessionChrome(state: DomainState): SessionChrome {
  return {
    agent: state.agent.channel === 'online' ? 'quiet' : 'prominent',
    connection: resolveConnectionPresence(state),
  };
}

/**
 * Session lifecycle + attach continuity only.
 *
 * The agent channel deliberately does not feed this member: the agent member
 * above already reports it, and rendering the same fact twice is exactly the
 * redundancy this policy exists to remove.
 */
function resolveConnectionPresence(state: DomainState): SessionChromePresence {
  if (state.session.channel === 'exited' || state.attachment.channel === 'failed') {
    return 'prominent';
  }
  if (state.attachment.channel === 'attaching') {
    return 'present';
  }
  // `attached` / `detached` / `unknown` add nothing the user can act on: an
  // unknown session has no agent to report it, and that agent is already
  // escalated by the member above.
  return 'quiet';
}
