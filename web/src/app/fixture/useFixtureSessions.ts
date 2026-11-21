import { useCallback, useMemo, useState } from 'react';
import {
  applySessionProjectBindings,
  fixtureSessionBindings,
  fixtureSessionProjectRevisions,
  fixtureSessions,
} from './fixtureSessions';
import { applySessionActivity, fixtureSessionActivity } from './fixtureSessionActivity';
import { useFixtureSessionMetadata } from './fixtureSessionMetadata';

/**
 * The fixture's Session set with the explicit Project membership input (#3082).
 *
 * Both inputs come from the route; the Project wire lives on the one
 * `sessionsApi` surface the metadata stub installs, and a successful
 * association updates the local set so the chip/Peek re-resolve immediately.
 * The revision generation rides along so a stale editor can conflict (#4234).
 */
export function useFixtureSessions(search: string) {
  const initialBindings = useMemo(() => fixtureSessionBindings(search), [search]);
  const initialRevisions = useMemo(() => fixtureSessionProjectRevisions(search), [search]);
  const [bindings, setBindings] = useState(initialBindings);
  const [revisions, setRevisions] = useState(initialRevisions);
  const onProjectSet = useCallback(
    (sessionId: string, projectId: string | null, revision: number) => {
      setBindings((current) => ({ ...current, [sessionId]: projectId }));
      setRevisions((current) => ({ ...current, [sessionId]: revision }));
    },
    [],
  );
  useFixtureSessionMetadata(search, { initialBindings, onProjectSet });
  const activity = useMemo(() => fixtureSessionActivity(search), [search]);
  return useMemo(
    () => applySessionActivity(
      applySessionProjectBindings(fixtureSessions(search), bindings, revisions),
      activity,
    ),
    [search, bindings, revisions, activity],
  );
}
