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
 * Replace the user fields. On success the cache (and every subscribed row)
 * immediately reflects the Agent's answer; on refusal the last loaded
 * metadata stays put and the caller keeps its draft.
 */
export async function saveSessionMetadata(
  sessionId: string,
  input: SessionMetadataInput,
): Promise<SessionMetadataResponse> {
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
  listeners.clear();
}
