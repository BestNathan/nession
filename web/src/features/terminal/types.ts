/** Viewport size shared by the agent (P2P) and server (relay) terminal APIs. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Outcome of a `client.attach` request. The agent acks attach with `ok` or
 * `error` on the same message id; the request layer turns those into a
 * resolution or a rejection, and the typed API converges both into this
 * union so callers never handle a thrown attach.
 */
export type AttachResult = { ok: true } | { ok: false; error: string };
