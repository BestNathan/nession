// web/src/product/session/state/metadata.ts
//
// The client's cache of Session-owned metadata (#2789). One entry per
// `session_id`, loaded on demand and shared by the Session list's row titles
// and the Workspace details editor so a save updates both without a refetch.
//
// The Agent owns the data; this module never invents a merged view. A failed
// load leaves `metadata: null` (rows fall back to the tmux name) rather than
// keeping a previous value from masquerading as the current one.
import { sessionsApi } from '@/product/session';
import type {
  SessionMetadata,
  SessionMetadataInput,
  SessionMetadataResponse,
} from '@/product/session/types';

export type SessionMetadataStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface SessionMetadataEntry {
  status: SessionMetadataStatus;
  metadata: SessionMetadata | null;
  error: string | null;
  /** The Agent/Server classification: conflict, invalid, not_found, ... */
  errorKind: string | null;
}

const EMPTY_ENTRY: SessionMetadataEntry = Object.freeze({
  status: 'idle',
  metadata: null,
  error: null,
  errorKind: null,
});

const entries = new Map<string, SessionMetadataEntry>();
const listeners = new Set<() => void>();
/**
 * Per-session request order: only the newest answer may write the cache. A
 * successful save advances the same order, because a read that started before
 * the Agent committed its revision must not republish the older one (#3319).
 *
 * The order fences *answers*, not revisions: a Session recreated under the
 * same name legitimately starts again at revision 0, so a read this client
 * starts after a save is authoritative even if its revision is lower.
 */
const requestSequence = new Map<string, number>();
/**
 * The durable tmux instance each cached `session_id` last named (#3424).
 *
 * `session_id` is recyclable, so the cache must notice when an authoritative
 * Session list says the same public id now names a different instance. The map
 * keeps the previous value rather than deleting it: a Session that disappears
 * from one list and reappears under the same name is exactly the replacement
 * the comparison must catch.
 */
const incarnations = new Map<string, string>();
/**
 * How many same-public-id replacements this client has observed per Session.
 *
 * The request sequence orders answers within one incarnation; this counter
 * marks the boundaries between incarnations. A save captures it when the
 * request starts and may only publish its answer while the epoch is unchanged
 * (#3748). A replacement observed in between means the committed answer
 * describes the previous instance, whose context the replacement already
 * cleared and whose successor read must stay authoritative.
 *
 * Counting replacements rather than comparing raw incarnation values keeps an
 * absent `instance_id` meaningful: the first report for a Session is the Agent
 * finally identifying its current instance, not a new incarnation (#3424).
 */
const incarnationEpochs = new Map<string, number>();

/** The fields an authoritative Session list contributes to incarnation identity. */
export interface SessionIncarnationRef {
  session_id: string;
  instance_id?: string | null;
}

function publish(sessionId: string, entry: SessionMetadataEntry): void {
  entries.set(sessionId, entry);
  for (const listener of listeners) {
    listener();
  }
}

/** Start a request, or fence every request older than a successful write. */
function advanceRequestSequence(sessionId: string): number {
  const sequence = (requestSequence.get(sessionId) ?? 0) + 1;
  requestSequence.set(sessionId, sequence);
  return sequence;
}

function incarnationEpoch(sessionId: string): number {
  return incarnationEpochs.get(sessionId) ?? 0;
}

function publishLoaded(sessionId: string, metadata: SessionMetadata): void {
  publish(sessionId, {
    status: 'loaded',
    metadata,
    error: null,
    errorKind: null,
  });
}

export function getSessionMetadataEntry(sessionId: string): SessionMetadataEntry {
  return entries.get(sessionId) ?? EMPTY_ENTRY;
}

export function subscribeSessionMetadata(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isSettled(entry: SessionMetadataEntry): boolean {
  return entry.status === 'loading' || entry.status === 'loaded';
}

/**
 * Read one Session's metadata. Concurrent callers share the newest request;
 * a `force` read still obeys the same per-session ordering, so an older
 * response can never overwrite a newer one.
 */
export async function loadSessionMetadata(
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<SessionMetadataEntry> {
  if (!sessionId) {
    return EMPTY_ENTRY;
  }
  const current = getSessionMetadataEntry(sessionId);
  if (!opts.force && isSettled(current)) {
    return current;
  }

  const sequence = advanceRequestSequence(sessionId);
  publish(sessionId, {
    status: 'loading',
    metadata: null,
    error: null,
    errorKind: null,
  });

  let response: SessionMetadataResponse;
  try {
    response = await sessionsApi.getMetadata(sessionId);
  } catch (error) {
    if (requestSequence.get(sessionId) === sequence) {
      publish(sessionId, {
        status: 'error',
        metadata: null,
        error: error instanceof Error ? error.message : 'Session metadata is unavailable.',
        errorKind: 'unavailable',
      });
    }
    return getSessionMetadataEntry(sessionId);
  }

  if (requestSequence.get(sessionId) !== sequence) {
    // A newer read owns the answer; this response belongs to a stale view.
    return getSessionMetadataEntry(sessionId);
  }

  if (!response.success || !response.metadata) {
    // A failed load discards the previously loaded value rather than letting
    // it masquerade as the current one.
    publish(sessionId, {
      status: 'error',
      metadata: null,
      error: response.error ?? 'Session metadata is unavailable.',
      errorKind: response.error_kind ?? 'unavailable',
    });
  } else {
    publishLoaded(sessionId, response.metadata);
  }
  return getSessionMetadataEntry(sessionId);
}

/**
 * Apply the incarnation identity an authoritative Session list reports (#3424).
 *
 * A recyclable `agent_id:session_name` is not an incarnation. When the list
 * reports a different durable instance for the same public id, the name-keyed
 * entry belongs to the previous incarnation: fence any answer still in flight,
 * publish the empty state so no row keeps showing the old context, and read the
 * new instance's own (possibly empty) metadata.
 *
 * An absent `instance_id` means a legacy Agent has not reported yet, not a new
 * incarnation, so it changes nothing.
 */
export function observeSessionIncarnations(
  sessions: readonly SessionIncarnationRef[],
): void {
  const replaced: string[] = [];
  for (const session of sessions) {
    if (!session.instance_id) {
      continue;
    }
    const previous = incarnations.get(session.session_id);
    incarnations.set(session.session_id, session.instance_id);
    if (previous !== undefined && previous !== session.instance_id) {
      replaced.push(session.session_id);
    }
  }
  for (const sessionId of replaced) {
    incarnationEpochs.set(
      sessionId,
      incarnationEpoch(sessionId) + 1,
    );
    advanceRequestSequence(sessionId);
    publish(sessionId, EMPTY_ENTRY);
    // The new instance's metadata may legitimately be empty at revision 0;
    // ask now so a mounted row or details view does not stay on the tmux-name
    // fallback until something else happens to reload it.
    void loadSessionMetadata(sessionId, { force: true });
  }
}

/**
 * Replace the user fields. On success the cache (and every subscribed row)
 * immediately reflects the Agent's answer; on refusal the last loaded
 * metadata stays put and the caller keeps its draft.
 *
 * A successful answer is only published while the Session still names the
 * incarnation the request was sent under (#3748). If an authoritative list
 * reported a same-name replacement while the write was in flight, the answer
 * describes the previous incarnation: publishing it would restore that
 * context into the replacement, and advancing the order would fence the
 * replacement's own read. The replacement path already published the empty
 * state and started that read, so it remains the owner of the displayed value.
 */
export async function saveSessionMetadata(
  sessionId: string,
  input: SessionMetadataInput,
): Promise<SessionMetadataResponse> {
  // Captured before the request leaves: an incarnation replacement observed
  // after this point invalidates whatever the Agent answers.
  const requestEpoch = incarnationEpoch(sessionId);
  let response: SessionMetadataResponse;
  try {
    response = await sessionsApi.updateMetadata(sessionId, input);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Session metadata could not be saved.',
      error_kind: 'unavailable',
      metadata: null,
    };
  }
  if (response.success && response.metadata) {
    if (incarnationEpoch(sessionId) !== requestEpoch) {
      // A replacement owns the public id now. Its empty projection and fresh
      // read are the truthful state; this answer belongs to the previous
      // incarnation and neither publishes nor fences.
      return response;
    }
    // The Agent committed a newer revision. Fence every read that was already
    // in flight: its answer predates this write and must not overwrite it,
    // even if no newer read starts before it settles (#3319).
    advanceRequestSequence(sessionId);
    publishLoaded(sessionId, response.metadata);
  }
  // A refused or failed save changes neither the order nor the cache: the
  // caller keeps its draft, and a pending read may still publish the Agent's
  // current answer.
  return response;
}

/** Tests only: forget every cached answer and subscription. */
export function resetSessionMetadataCache(): void {
  entries.clear();
  requestSequence.clear();
  incarnations.clear();
  incarnationEpochs.clear();
  listeners.clear();
}
