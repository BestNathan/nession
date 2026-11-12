import { useCallback, useMemo, useState } from 'react';
import {
  applySessionProjectBindings,
  fixtureSessionBindings,
  fixtureSessions,
} from './fixtureSessions';
import { useFixtureSessionMetadata } from './fixtureSessionMetadata';

/**
 * The fixture's Session set with the explicit Project membership input (#3082).
 *
 * Both inputs come from the route; the Project wire lives on the one
 * `sessionsApi` surface the metadata stub installs, and a successful
 * association updates the local set so the chip/Peek re-resolve immediately.
 */
export function useFixtureSessions(search: string) {
  const initialBindings = useMemo(() => fixtureSessionBindings(search), [search]);
  const [bindings, setBindings] = useState(initialBindings);
  const onProjectSet = useCallback((sessionId: string, projectId: string | null) => {
    setBindings((current) => ({ ...current, [sessionId]: projectId }));
  }, []);
  useFixtureSessionMetadata(search, { initialBindings, onProjectSet });
  return useMemo(
    () => applySessionProjectBindings(fixtureSessions(search), bindings),
    [search, bindings],
  );
}
