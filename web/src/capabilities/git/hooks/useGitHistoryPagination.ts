import { useCallback, useEffect, useRef, useState } from 'react';
import { gitApi } from '../GitPlugin';
import { describeUnavailable } from '../state';
import { gitRequestTargetKey } from './useGitRequest';
import type { GitCommit, GitLogResponse } from '../types';

/**
 * A paged History list that belongs to exactly one target and one first page.
 *
 * The first page arrives through `useGitRequest`, which fences its own late
 * answers by generation and request identity. An older page is a *second*
 * question, and it publishes into a list the first page built: appending is
 * only meaningful while the answer that established the list is still the one
 * on screen. Moving Session, refreshing, or being invalidated replaces that
 * first page; an older page started against the previous one describes a
 * different repository's history (or a continuation the newer answer already
 * supplied) and must be dropped rather than appended (#3751).
 *
 * Fencing covers both halves of a read: its data and its terminal state. A
 * settled obsolete request may neither append commits nor change the cursor,
 * end flag, or loading state that belongs to the list currently displayed.
 */
export function useGitHistoryPagination(
  history: GitLogResponse | null | undefined,
  agentId: string | undefined,
  sessionId: string | undefined,
) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [endOfHistory, setEndOfHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // A bounded, resettable error from the most recent older-page read. Cleared
  // when the target/generation changes (the list it described is gone) and
  // when a new read starts (the retry supersedes the previous outcome). A
  // stale continuation may neither publish its error nor clear the loading
  // state of the successor that replaced it (#4141, builds on #3751 fencing).
  const [olderError, setOlderError] = useState<string | null>(null);

  const targetKey =
    agentId && sessionId
      ? gitRequestTargetKey({ agent_id: agentId, session: sessionId })
      : null;
  // The target the displayed list belongs to. A target change is a new list
  // even before its first page arrives: the previous Session's list is not B's.
  const activeTarget = useRef<string | null>(targetKey);
  // Bumped whenever a new first page establishes the list: a target change or a
  // replaced first-page answer (refresh, invalidation, reconnect).
  const generation = useRef(0);
  // Identity of the most recently started older-page read, so an obsolete
  // completion cannot clear a newer read's loading state.
  const requestSequence = useRef(0);

  useEffect(() => {
    const targetChanged = activeTarget.current !== targetKey;
    generation.current += 1;
    requestSequence.current += 1;
    activeTarget.current = targetKey;
    setLoadingMore(false);
    setOlderError(null);
    // The previous target's answer is not a first page for this one, even if
    // both are still in this render's props.
    const page = !targetChanged && history?.state === 'ok' ? history.history : null;
    setCommits(page?.commits ?? []);
    setNextCursor(page?.next_cursor ?? null);
    setEndOfHistory(page?.end_of_history ?? false);
  }, [history, targetKey]);

  const loadOlder = useCallback(async () => {
    if (!agentId || !sessionId || !nextCursor || loadingMore) {
      return;
    }
    const forTarget = gitRequestTargetKey({ agent_id: agentId, session: sessionId });
    const forGeneration = generation.current;
    const forRequest = ++requestSequence.current;
    const cursor = nextCursor;
    // The retry supersedes the previous outcome: clear any prior error before
    // the new read starts so a stale error cannot outlive its own request.
    setOlderError(null);
    setLoadingMore(true);
    try {
      const page = await gitApi.gitLog({
        agent_id: agentId,
        session: sessionId,
        before: cursor,
      });
      // The list this page continues must still be the displayed one.
      if (
        generation.current !== forGeneration ||
        requestSequence.current !== forRequest ||
        activeTarget.current !== forTarget
      ) {
        return;
      }
      if (page.state === 'ok') {
        setCommits((prev) => [...prev, ...page.history.commits]);
        setNextCursor(page.history.next_cursor ?? null);
        setEndOfHistory(page.history.end_of_history);
      } else {
        // A fulfilled non-ok answer is the agent's domain answer, not a
        // transport failure: it describes no page, so the loaded list, cursor,
        // and end flag stay exactly as they were. The same Load older control
        // remains the retry, and the reason is shown beside it. The fence
        // above already dropped an answer for a replaced list (#4116).
        setOlderError(describeUnavailable(page).title);
      }
    } catch {
      // Same fence as the success path: a rejected continuation for a replaced
      // list may neither publish its error nor disturb the successor's loading
      // state (#4141 SC-02, building on #3751 fencing).
      if (
        generation.current !== forGeneration ||
        requestSequence.current !== forRequest ||
        activeTarget.current !== forTarget
      ) {
        return;
      }
      setOlderError('Could not load older commits. Try again.');
    } finally {
      // Same fence for the terminal state: an answer for a replaced list must
      // not clear the loading flag of the one that replaced it.
      if (
        generation.current === forGeneration &&
        requestSequence.current === forRequest &&
        activeTarget.current === forTarget
      ) {
        setLoadingMore(false);
      }
    }
  }, [agentId, sessionId, nextCursor, loadingMore]);

  return { commits, nextCursor, endOfHistory, loadingMore, olderError, loadOlder };
}
