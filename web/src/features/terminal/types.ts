/** Viewport size shared by the agent (P2P) and server (relay) terminal APIs. */
import type { AttachInfo, AddressLatency, EnvFileRef } from '@/types';

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

/**
 * Shell attach descriptor for deep-link restoration. The app shell derives
 * this from the jotai atoms and passes it to useDeepLinkRestore.
 */
export interface AttachedSession {
  attachInfo: AttachInfo;
  sessionId: string;
  sessionName: string;
  orderedUrls?: string[];
  latencies?: AddressLatency[];
  selectedAddress?: string;
  /** Manual relay endpoint URL from the attach dialog (null = auto). */
  relayUrl?: string | null;
  renderer?: 'webgl' | 'canvas';
  /** Env files chosen in the attach dialog to source once the terminal is live. */
  envRefs?: EnvFileRef[];
}
