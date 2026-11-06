// web/src/product/session/hooks/useSessionMetadata.ts
//
// Reads the shared Session metadata cache (#2789). Rows use the display-title
// helper; the Workspace details editor uses the entry plus explicit reload.
import { useEffect, useRef, useState } from 'react';
import { sessionsApi } from '@/product/session';
import {
  getSessionMetadataEntry,
  loadSessionMetadata,
  subscribeSessionMetadata,
  type SessionMetadataEntry,
} from '@/product/session/state/metadata';

/**
 * One Session's metadata, loading it on first use and again when the
 * transport is reinstalled (a reconnect can follow an offline failure).
 */
export function useSessionMetadata(sessionId: string | null | undefined): SessionMetadataEntry {
  const id = sessionId ?? '';
  const [entry, setEntry] = useState<SessionMetadataEntry>(() =>
    getSessionMetadataEntry(id),
  );
  const [connectionRevision, setConnectionRevision] = useState(() =>
    sessionsApi.connectionRevision(),
  );
  // A revision change means the transport was replaced (a fixture stub being
  // bound, or a reconnect). The request that was in flight belonged to the
  // previous socket, so the new one has to be asked again even though the old
  // entry may still say `loading` when this effect runs.
  const observedRevision = useRef(connectionRevision);

  useEffect(() => {
    setEntry(getSessionMetadataEntry(id));
    return subscribeSessionMetadata(() => setEntry(getSessionMetadataEntry(id)));
  }, [id]);

  useEffect(() => sessionsApi.onConnectionChange(() => {
    setConnectionRevision(sessionsApi.connectionRevision());
  }), []);

  useEffect(() => {
    const force = connectionRevision !== observedRevision.current;
    observedRevision.current = connectionRevision;
    if (id) {
      void loadSessionMetadata(id, { force });
    }
  }, [id, connectionRevision]);

  return entry;
}
