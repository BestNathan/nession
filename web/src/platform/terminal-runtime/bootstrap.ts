/**
 * The bootstrap marker (#321) and what the agent says about the snapshot it
 * came with (#1305).
 *
 * A marked frame is the session's **history**, not more output, so it replaces
 * the consumer's buffer instead of appending to it. That rule is what lets the
 * agent re-send history on every attach that needs one without the user ending
 * up with two copies of it on screen.
 *
 * The marker's *contents* are what say whether that replacement is safe. The
 * agent bounds a capture at `BOOTSTRAP_MAX_BYTES` and drops the **oldest**
 * history when the ceiling bites
 * (`crates/nession-agent/src/server/bootstrap.rs`), so a truncated snapshot is
 * newer but shorter than what a long-attached client already holds — its
 * scrollback budget is 10k lines (mobile) / 50k (desktop) against the agent's
 * 5000-line capture. Applying one as if it were the whole history therefore
 * destroys context it cannot restore, which is the bug #1305 reports: the
 * client collapsed this payload to `true` and never saw `truncated`.
 */
export interface TerminalBootstrap {
  /**
   * How many lines of history the snapshot was asked for. Reported so a client
   * can tell "this is everything" from "this is everything that was
   * requested", without knowing the agent's constant.
   */
  requestedLines: number;
  /**
   * Whether a byte ceiling cut the snapshot short — the oldest history is
   * missing, not the newest. `false` means the snapshot is the history it
   * claims to be.
   */
  truncated: boolean;
}

/**
 * Read the marker off a decoded `agent.terminal.output` payload.
 *
 * Absence is the only thing that means "not a bootstrap" — a provider that
 * sends `bootstrap: {}` means the same thing as one that sends a populated
 * payload (#321). For a payload whose contents cannot be read, `truncated` is
 * the cautious answer rather than the convenient one: the two ways to be wrong
 * are "keep scrollback a complete snapshot would have replaced" and "delete
 * scrollback a truncated snapshot cannot restore", and only the second one
 * loses something the user cannot get back.
 */
export function decodeBootstrapMarker(raw: unknown): TerminalBootstrap | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const payload = (typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    requestedLines: typeof payload.requested_lines === 'number' ? payload.requested_lines : 0,
    truncated: payload.truncated !== false,
  };
}
