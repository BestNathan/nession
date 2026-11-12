import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGitMutations } from '../../hooks/useGitMutations';
import { useGitStatus } from '../../hooks/useGitStatus';
import type { GitRow } from '../../state';
import type {
  GitChangedFile,
  GitCreateCommitResponse,
  GitInvalidatedEvent,
  GitMutationResponse,
  GitStatusResponse,
} from '../../types';

// The hooks reach the plugin singleton; keep its transport mocked so every
// request settles exactly when the test says it does. No timers or guessing.
const harness = vi.hoisted(() => ({
  listeners: new Set<(event: GitInvalidatedEvent) => void>(),
  status: (target: { agent_id: string; session: string }): Promise<GitStatusResponse> => {
    void target;
    return Promise.reject(new Error('unexpected git.status'));
  },
  stage: (request: unknown): Promise<GitMutationResponse> => {
    void request;
    return Promise.reject(new Error('unexpected git.stage'));
  },
  unstage: (request: unknown): Promise<GitMutationResponse> => {
    void request;
    return Promise.reject(new Error('unexpected git.unstage'));
  },
  createCommit: (request: unknown): Promise<GitCreateCommitResponse> => {
    void request;
    return Promise.reject(new Error('unexpected git.create-commit'));
  },
}));

vi.mock('../../GitPlugin', () => ({
  gitApi: {
    onInvalidated: (listener: (event: GitInvalidatedEvent) => void) => {
      harness.listeners.add(listener);
      return () => {
        harness.listeners.delete(listener);
      };
    },
    gitStatus: (target: { agent_id: string; session: string }) => harness.status(target),
    gitStage: (request: unknown) => harness.stage(request),
    gitUnstage: (request: unknown) => harness.unstage(request),
    gitCreateCommit: (request: unknown) => harness.createCommit(request),
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function changedFile(path: string, staged: boolean): GitChangedFile {
  return { path, kind: 'modified', staged, unstaged: !staged };
}

function statusOk(branch: string, token: string, files: GitChangedFile[]): GitStatusResponse {
  return {
    state: 'ok',
    root: '/repo',
    snapshot: { token, head: null, root: '/repo' },
    truncated: false,
    truncatedBytes: 0,
    status: {
      branch,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      modified: files,
      untracked: [],
      unmerged: [],
    },
  };
}

function okFields(status: GitStatusResponse): {
  status: NonNullable<Extract<GitStatusResponse, { state: 'ok' }>['status']>;
  snapshot: Extract<GitStatusResponse, { state: 'ok' }>['snapshot'];
} {
  if (status.state !== 'ok') {
    throw new Error('fixture status must be ok');
  }
  return { status: status.status, snapshot: status.snapshot };
}

function mutationOk(status: GitStatusResponse): GitMutationResponse {
  return { state: 'ok', ...okFields(status), truncated: false, truncatedBytes: 0 };
}

function commitOk(status: GitStatusResponse): GitCreateCommitResponse {
  return {
    state: 'ok',
    ...okFields(status),
    truncated: false,
    truncatedBytes: 0,
    commit: { oid: 'created-oid', author: 'Fixture Dev <dev@example.com>' },
  };
}

const A_STAGED = statusOk('feat/a', 'snap-a', [
  changedFile('a-staged.ts', true),
  changedFile('a.ts', false),
]);
const A_AFTER = statusOk('feat/a-after', 'snap-a-after', [changedFile('a.ts', true)]);
const B_READ = statusOk('feat/b', 'snap-b', [changedFile('b.ts', false)]);
const B_AFTER = statusOk('feat/b-after', 'snap-b-after', [changedFile('b.ts', true)]);

const ROW_A: GitRow = {
  kind: 'unstaged',
  path: 'a.ts',
  key: 'unstaged:a.ts',
  file: changedFile('a.ts', false),
};

const ROW_B: GitRow = {
  kind: 'unstaged',
  path: 'b.ts',
  key: 'unstaged:b.ts',
  file: changedFile('b.ts', false),
};

function renderGitHooks(initial: { agentId: string; sessionId: string }) {
  return renderHook(
    ({ agentId, sessionId }: { agentId: string; sessionId: string }) => {
      const status = useGitStatus({ agentId, sessionId });
      const snapshot = status.status?.state === 'ok' ? status.status.snapshot : null;
      const mutations = useGitMutations({
        agentId,
        sessionId,
        snapshot,
        applyStatus: status.apply,
        reload: status.refresh,
      });
      return { status, mutations };
    },
    { initialProps: initial },
  );
}

function branchOf(view: ReturnType<typeof renderGitHooks>): string | null {
  const status = view.result.current.status.status;
  return status?.state === 'ok' ? (status.status.branch ?? null) : null;
}

describe('useGitMutations cross-Session ownership (#3327)', () => {
  let stageRequests: Deferred<GitMutationResponse>[];
  let commitRequests: Deferred<GitCreateCommitResponse>[];
  let commitBodies: Record<string, unknown>[];

  beforeEach(() => {
    harness.listeners.clear();
    stageRequests = [];
    commitRequests = [];
    commitBodies = [];
    harness.status = (target) =>
      Promise.resolve(target.session === 'session-a' ? A_STAGED : B_READ);
    harness.stage = () => {
      const request = deferred<GitMutationResponse>();
      stageRequests.push(request);
      return request.promise;
    };
    harness.unstage = () => Promise.reject(new Error('unexpected git.unstage'));
    harness.createCommit = (request) => {
      commitBodies.push(request as Record<string, unknown>);
      const deferredRequest = deferred<GitCreateCommitResponse>();
      commitRequests.push(deferredRequest);
      return deferredRequest.promise;
    };
  });

  it('a late stage success from the previous Session never overwrites B, and B owns its own stage (#3327 SC-01)', async () => {
    const view = renderGitHooks({ agentId: 'agent-a', sessionId: 'session-a' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/a'));

    act(() => view.result.current.mutations.stage(ROW_A));
    expect(stageRequests).toHaveLength(1);
    expect(view.result.current.mutations.busyKey).toBe(ROW_A.key);

    view.rerender({ agentId: 'agent-b', sessionId: 'session-b' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/b'));
    expect(view.result.current.mutations.busyKey).toBeNull();

    // A's success carries A's post-state, but B is the visible Session.
    await act(async () => {
      stageRequests[0].resolve(mutationOk(A_AFTER));
      await stageRequests[0].promise;
    });
    expect(branchOf(view)).toBe('feat/b');
    expect(view.result.current.mutations.notice).toBeNull();
    expect(view.result.current.mutations.busyKey).toBeNull();

    // B's own request is not blocked by A's late answer.
    act(() => view.result.current.mutations.stage(ROW_B));
    expect(stageRequests).toHaveLength(2);
    await act(async () => {
      stageRequests[1].resolve(mutationOk(B_AFTER));
      await stageRequests[1].promise;
    });
    expect(branchOf(view)).toBe('feat/b-after');
    expect(view.result.current.mutations.notice).toBeNull();
    expect(view.result.current.mutations.busyKey).toBeNull();
  });

  it('a late repository_changed answer from the previous Session never replaces B or shows its notice (#3327 SC-01)', async () => {
    const view = renderGitHooks({ agentId: 'agent-a', sessionId: 'session-a' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/a'));

    act(() => view.result.current.mutations.stage(ROW_A));
    view.rerender({ agentId: 'agent-b', sessionId: 'session-b' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/b'));

    await act(async () => {
      stageRequests[0].resolve({
        state: 'repository_changed',
        message: 'The repository changed after it was reviewed.',
        ...okFields(A_STAGED),
        truncated: false,
        truncatedBytes: 0,
      });
      await stageRequests[0].promise;
    });

    expect(branchOf(view)).toBe('feat/b');
    expect(view.result.current.mutations.notice).toBeNull();
  });

  it('a late transport failure from the previous Session never appears in B (#3327 SC-01)', async () => {
    const view = renderGitHooks({ agentId: 'agent-a', sessionId: 'session-a' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/a'));

    act(() => view.result.current.mutations.stage(ROW_A));
    view.rerender({ agentId: 'agent-b', sessionId: 'session-b' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/b'));

    await act(async () => {
      stageRequests[0].reject(new Error('agent connection lost'));
      await stageRequests[0].promise.catch(() => undefined);
    });

    expect(branchOf(view)).toBe('feat/b');
    expect(view.result.current.mutations.notice).toBeNull();
    expect(view.result.current.mutations.busyKey).toBeNull();
  });

  it('a late commit from A cannot clear B busy or replace B, and A keeps its retry identity (#3327 SC-01)', async () => {
    const view = renderGitHooks({ agentId: 'agent-a', sessionId: 'session-a' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/a'));

    act(() => {
      void view.result.current.mutations.commit('commit A');
    });
    expect(commitRequests).toHaveLength(1);
    expect(commitBodies[0]).toMatchObject({ session: 'session-a', message: 'commit A' });
    expect(view.result.current.mutations.commitBusy).toBe(true);

    view.rerender({ agentId: 'agent-b', sessionId: 'session-b' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/b'));
    expect(view.result.current.mutations.commitBusy).toBe(false);

    // B's own commit starts while A's answer is still held.
    act(() => {
      void view.result.current.mutations.commit('commit B');
    });
    expect(commitRequests).toHaveLength(2);
    expect(view.result.current.mutations.commitBusy).toBe(true);

    // A settles first. It must neither apply A's state nor clear B's busy flag.
    await act(async () => {
      commitRequests[0].resolve(commitOk(A_AFTER));
      await commitRequests[0].promise;
    });
    expect(branchOf(view)).toBe('feat/b');
    expect(view.result.current.mutations.commitBusy).toBe(true);
    expect(view.result.current.mutations.notice).toBeNull();

    // B settles with its own authoritative state.
    await act(async () => {
      commitRequests[1].resolve(commitOk(B_AFTER));
      await commitRequests[1].promise;
    });
    expect(branchOf(view)).toBe('feat/b-after');
    expect(view.result.current.mutations.commitBusy).toBe(false);

    // Return to A: its request identity is still the one captured at dispatch,
    // so a retry of the same message/snapshot reuses it rather than minting a
    // new commit (#845 SC-09).
    view.rerender({ agentId: 'agent-a', sessionId: 'session-a' });
    await waitFor(() => expect(branchOf(view)).toBe('feat/a'));
    act(() => {
      void view.result.current.mutations.commit('commit A');
    });
    expect(commitBodies[2]).toMatchObject({
      session: 'session-a',
      message: 'commit A',
      expectedSnapshot: 'snap-a',
      requestId: commitBodies[0].requestId,
    });
  });
});
