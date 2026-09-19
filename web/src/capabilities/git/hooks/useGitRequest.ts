import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * What a git request is addressed to. `agent_id` is routing, not context — the
 * server relays `extension.*` to the named agent and answers `missing agent_id`
 * without it.
 */
export interface GitRequestTarget {
  agent_id: string;
  session: string;
}

export interface GitRequestState<T> {
  data: T | null;
  loading: boolean;
  /** A transport failure — distinct from a state the agent answered with. */
  error: string | null;
}

/**
 * One git request, pulled when the target changes and when the caller asks.
 *
 * ## Why this is shared
 *
 * Four questions in this capability are the same request with a different
 * answer: repository state, history, branches, worktrees. Each needs the same
 * three things — the target rebuilt only when the Session actually changes, a
 * generation guard so a response that arrives after the context moved on is
 * dropped rather than written over the new one, and pull-on-open rather than a
 * poll. Written four times those are four chances to disagree about staleness,
 * which is the failure a view cannot detect: it renders a stale answer as
 * confidently as a fresh one.
 *
 * ## Pull-on-open, never a poll
 *
 * The model `#750`'s Open Question 3 settled on and `claude_code.list` already
 * used. The repository is resolved agent-side from the Session's *live* working
 * directory on every call, so a `cd` inside the Session is picked up by the
 * next request rather than needing to be pushed.
 *
 * ## Mounting is the request
 *
 * There is no `enabled` flag. A section that should not fetch is a section that
 * is not mounted — which is what `GitWorkspace` does with its sections, and why
 * a reader who never opens Branches never makes the agent run `for-each-ref`.
 * A flag would let a mounted-but-disabled section exist, and that is the state
 * whose cost is invisible.
 *
 * `load` must be stable (wrap it in `useCallback`): this hook depends on it, and
 * an inline arrow would re-run the effect on every render.
 */
export function useGitRequest<T>({
  agentId,
  sessionId,
  load,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  load: (target: GitRequestTarget) => Promise<T>;
}): GitRequestState<T> & { refresh: () => void } {
  const [state, setState] = useState<GitRequestState<T>>({
    data: null,
    // Optimistic: the effect below starts a load on mount, so starting at
    // "not loading" would render an empty state for a frame before the request
    // had even left.
    loading: true,
    error: null,
  });

  // Bumped whenever the Session changes; a response that arrives after the
  // context moved on is dropped rather than written over the new one.
  const generation = useRef(0);
  const target = useRef<GitRequestTarget | null>(null);

  const run = useCallback(
    async (forGeneration: number) => {
      const current = target.current;
      if (!current) {
        return;
      }
      setState((previous) => ({ ...previous, loading: true, error: null }));
      try {
        const data = await load(current);
        if (generation.current !== forGeneration) {
          return;
        }
        setState({ data, loading: false, error: null });
      } catch (error) {
        if (generation.current !== forGeneration) {
          return;
        }
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not reach the agent',
        });
      }
    },
    [load],
  );

  useEffect(() => {
    generation.current += 1;
    const forGeneration = generation.current;
    target.current = agentId && sessionId ? { agent_id: agentId, session: sessionId } : null;
    setState({ data: null, loading: Boolean(target.current), error: null });
    if (target.current) {
      void run(forGeneration);
    }
    // The two ids are the dependencies, not a `target` object rebuilt on every
    // render: identity would re-run this effect without anything having changed.
  }, [run, agentId, sessionId]);

  const refresh = useCallback(() => {
    void run(generation.current);
  }, [run]);

  return { ...state, refresh };
}
