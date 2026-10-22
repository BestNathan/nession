import type { VerifiedTerminalBaseline } from './AppliedTerminalCursor';

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
  /** A separately proven snapshot/output-stream cut; legacy absence is unverified. */
  cutConsistency?: 'atomic' | 'unverified';
  /** VT representation. Even a complete text capture is never full-vt. */
  fidelity?: 'full-vt' | 'screen-only' | 'partial';
  /** Optional, explicit identity of an actual Agent stream cut. */
  streamEpoch?: number;
  throughSeq?: number;
}

/**
 * The stream-log cut a bootstrap proves: an atomic, complete prefix of the
 * Agent's ordered output log from seq 1 through `throughSeq`, or an atomic
 * checkpoint at the stream's **position 0**.
 *
 * A `throughSeq = 0` cut is the control-channel attach barrier (#2124): the
 * session stream is created with the attach, the capture covers everything
 * before it, and every live event recorded afterwards is seq 1 or later. It
 * proves no stream event precedes the cut, so a renderer may start there even
 * when the capture is truncated or `screen-only` — truncation and fidelity
 * describe the screen, not the stream position. A `throughSeq > 0` cut is a
 * complete replay of the event log and must not be truncated.
 *
 * This is **not** a VT/screen checkpoint, and it is not a claim that the
 * client's buffer holds the session's history. It proves exactly one thing:
 * no output byte the Agent's stream issued at or below the cut is missing from
 * a renderer that started empty at that position.
 *
 * The caller must reset the renderer to the cut before writing a replay
 * payload (the bootstrap writer is serialized, so that reset precedes these
 * bytes); an epoch-start cut has no replay to reset for. Report the baseline
 * only from the write callback of the current renderer/subscription
 * generation. A screen-only or unverified capture yields `undefined`.
 */
export function streamBaselineFromBootstrap(
  bootstrap: TerminalBootstrap | undefined,
): VerifiedTerminalBaseline | undefined {
  if (bootstrap?.cutConsistency !== 'atomic') {
    return undefined;
  }
  const epoch = bootstrap.streamEpoch;
  const through = bootstrap.throughSeq;
  if (!Number.isSafeInteger(epoch) || (epoch ?? 0) <= 0
    || !Number.isSafeInteger(through) || (through ?? -1) < 0) {
    return undefined;
  }
  // Position 0 has no preceding stream events to apply, so a truncated screen
  // snapshot cannot make the stream position false. A later cut is a replay.
  if (through as number > 0 && bootstrap.truncated) {
    return undefined;
  }
  return { kind: 'verified', streamEpoch: epoch as number, appliedThrough: through as number };
}

/**
 * Parser completion is not proof of a checkpoint. A partial or unverified
 * capture can repaint visible text but cannot erase the recovery gap.
 * Future atomic cut support can make this true only with full VT fidelity.
 */
export function provesVerifiedBootstrapRepair(bootstrap: TerminalBootstrap | undefined): boolean {
  return bootstrap?.cutConsistency === 'atomic'
    && bootstrap.fidelity === 'full-vt'
    && !bootstrap.truncated
    && Number.isSafeInteger(bootstrap.streamEpoch) && (bootstrap.streamEpoch ?? 0) > 0
    && Number.isSafeInteger(bootstrap.throughSeq) && (bootstrap.throughSeq ?? -1) >= 0;
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
    ...(payload.cut_consistency === 'atomic' || payload.cut_consistency === 'unverified'
      ? { cutConsistency: payload.cut_consistency } : {}),
    ...(payload.fidelity === 'full-vt'
      || payload.fidelity === 'screen-only' || payload.fidelity === 'partial'
      ? { fidelity: payload.fidelity } : {}),
    ...(Number.isSafeInteger(payload.stream_epoch) && (payload.stream_epoch as number) > 0
      ? { streamEpoch: payload.stream_epoch as number } : {}),
    ...(Number.isSafeInteger(payload.through_seq) && (payload.through_seq as number) >= 0
      ? { throughSeq: payload.through_seq as number } : {}),
  };
}
