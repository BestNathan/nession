import type { InputDrop, InputDropReason } from '@/platform/terminal-runtime/inputQueue';

/**
 * The terminal input a canonical fixture route can express: an input the
 * Session lost rather than delivered.
 *
 * A delivery-unknown is not a rendering the surface chooses — it is the answer
 * to something that happened to a live transport (#1307 SC-09). Four things
 * produce one and the fixture can be given none of them: an Agent that
 * restarted mid-session, a TTL that expired, a bound that refused a keystroke,
 * and a control lease that moved to another client. So the parameter names the
 * *reason* — the input the product cannot otherwise be handed — exactly as
 * `fixtureStaleAgents` names which Agents failed to answer and
 * `fixtureCapabilityFacts` names resolution inputs. A parameter that named the
 * notice directly would be asking for a rendering instead of an input, and a
 * test asserting it would assert a sentence `TerminalSurface` never decided on.
 *
 *   /#/fixture/app?drop=epoch → the Agent's input epoch moved, so the client
 *                               cannot say whether the bytes in flight reached
 *                               the PTY — the one case the notice must not be
 *                               silent about
 *
 * Only the reason is read, and it is the whole input: `TerminalSurface` picks
 * its sentence from `drop.reason` alone. `chunks` and `at` are carried because
 * `InputDrop` requires them, with the same values the surface's own test uses —
 * they reach no rendering, so a case cannot be given one that would.
 *
 * Absent, empty, or naming a reason the product cannot produce means "no
 * drop", which is the untouched canonical route — so the golden screenshots do
 * not move.
 */
const DROP_REASONS: readonly InputDropReason[] = [
  'bound',
  'age',
  'epoch',
  'generation',
];

export function fixtureInputDrop(search: string): InputDrop | null {
  const reason = new URLSearchParams(search).get('drop');
  if (reason === null) {
    return null;
  }
  // `find` rather than a cast: the route is user-typeable, and a reason outside
  // the union is not an input the product can be handed. Letting one through
  // would leave `inputDropNotice` with nothing to return and the notice
  // rendering as an empty strip — a state no Session can be in.
  const known = DROP_REASONS.find((candidate) => candidate === reason);
  return known === undefined ? null : { reason: known, chunks: 1, at: 0 };
}
