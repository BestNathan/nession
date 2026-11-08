import { useCallback, useRef, useState } from 'react';

import { gitApi } from '../GitPlugin';
import type {
  GitCreateCommitResponse,
  GitMutationFailure,
  GitMutationOk,
  GitMutationResponse,
  GitSnapshot,
  GitStatusResponse,
  GitUnstageResponse,
} from '../types';
import type { GitRow } from '../state';

/** What a mutation failure reads as in the view. */
export interface GitMutationNotice {
  tone: 'muted' | 'destructive';
  message: string;
}

export interface GitMutationController {
  /** The row whose stage/unstage is in flight, if any. */
  busyKey: string | null;
  commitBusy: boolean;
  notice: GitMutationNotice | null;
  dismissNotice: () => void;
  stage: (row: GitRow) => void;
  unstage: (row: GitRow) => void;
  /** Resolves whether the commit was created (not merely attempted). */
  commit: (message: string) => Promise<boolean>;
}

function transportMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not reach the agent';
}

const LOADING_NOTICE = 'The repository state is still loading.';

/**
 * The status a successful mutation's post-state describes.
 *
 * The response carries an authoritative status and snapshot; reconstructing
 * the v2 status answer from it keeps the view's one source of truth (the
 * status hook) without a second read that could fail or race.
 */
function statusFromMutation(ok: GitMutationOk): GitStatusResponse {
  return {
    state: 'ok',
    status: ok.status,
    root: ok.snapshot.root,
    snapshot: ok.snapshot,
    truncated: ok.truncated,
    truncatedBytes: ok.truncatedBytes,
  };
}

type StateBearingFailure =
  | Extract<GitMutationFailure, { state: 'repository_changed' }>
  | Extract<GitMutationFailure, { state: 'failed' }>;

function statusFromState(failure: StateBearingFailure): GitStatusResponse | null {
  if (!failure.snapshot || !failure.status) {
    return null;
  }
  return {
    state: 'ok',
    status: failure.status,
    root: failure.snapshot.root,
    snapshot: failure.snapshot,
    truncated: failure.state === 'repository_changed' ? failure.truncated : false,
    truncatedBytes: failure.state === 'repository_changed' ? failure.truncatedBytes : 0,
  };
}

function copyFor(failure: GitMutationFailure): string {
  switch (failure.state) {
    case 'repository_changed':
      return 'The repository changed after it was reviewed. Nothing was applied; the list now shows the current state.';
    case 'refused':
    case 'failed':
    case 'missing_identity':
    case 'unavailable':
    case 'not_a_repository':
      return failure.message;
  }
}

/**
 * One user-initiated request id for a commit.
 *
 * Reused while the same message is retried against the same reviewed snapshot,
 * so a lost response answered late cannot create a second commit (#845
 * SC-09). A new message or a refreshed repository state is a new identity.
 */
function newRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return `commit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type RowRequest = {
  agent_id: string;
  session: string;
  path: string;
  expectedSnapshot: string;
};

type RowOutcome =
  | { ok: true; response: GitMutationResponse | GitUnstageResponse }
  | { ok: false; error: string };

/** One row mutation, with transport failure kept separate from an answer. */
async function requestRowMutation({
  agentId,
  sessionId,
  snapshot,
  row,
  action,
}: {
  agentId: string;
  sessionId: string;
  snapshot: GitSnapshot;
  row: GitRow;
  action: (request: RowRequest) => Promise<GitMutationResponse | GitUnstageResponse>;
}): Promise<RowOutcome> {
  try {
    const response = await action({
      agent_id: agentId,
      session: sessionId,
      path: row.path,
      expectedSnapshot: snapshot.token,
    });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error: transportMessage(error) };
  }
}

/**
 * Take a mutation's answer into the view.
 *
 * Success is the authoritative post-state; a stale review carries the current
 * state and a muted explanation; a failure may carry the state the command left
 * behind and otherwise forces a fresh read. Returns whether the mutation
 * produced the state the caller asked for.
 */
function adoptMutationResponse(
  response: GitMutationResponse | GitCreateCommitResponse,
  applyStatus: (status: GitStatusResponse) => void,
  reload: () => void,
  setNotice: (notice: GitMutationNotice | null) => void,
): boolean {
  if (response.state === 'ok') {
    applyStatus(statusFromMutation(response));
    setNotice(null);
    return true;
  }

  const current =
    response.state === 'repository_changed' || response.state === 'failed'
      ? statusFromState(response)
      : null;
  if (current) {
    applyStatus(current);
  } else if (response.state === 'failed') {
    // The command ran and its post-state could not be read; a fresh read is
    // the only remaining way to say what is true.
    reload();
  }
  setNotice({ tone: 'destructive', message: copyFor(response) });
  return false;
}

/**
 * Stage, unstage and commit for one Session's repository (#845).
 *
 * Every request carries the snapshot from the status the user is looking at.
 * The agent refuses a stale one, so this hook never has to decide whether the
 * view is current: it adopts the answer's authoritative state, explains the
 * refusal, and leaves the repository untouched.
 */
export function useGitMutations({
  agentId,
  sessionId,
  snapshot,
  applyStatus,
  reload,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  snapshot: GitSnapshot | null;
  applyStatus: (status: GitStatusResponse) => void;
  reload: () => void;
}): GitMutationController {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [notice, setNotice] = useState<GitMutationNotice | null>(null);
  const pendingCommit = useRef<{
    message: string;
    snapshot: string;
    requestId: string;
  } | null>(null);

  const adopt = useCallback(
    (response: GitMutationResponse | GitCreateCommitResponse): boolean =>
      adoptMutationResponse(response, applyStatus, reload, setNotice),
    [applyStatus, reload],
  );

  const mutateRow = useCallback(
    async (
      row: GitRow,
      action: (request: RowRequest) => Promise<GitMutationResponse | GitUnstageResponse>,
    ) => {
      if (!agentId || !sessionId || !snapshot) {
        return setNotice({ tone: 'destructive', message: LOADING_NOTICE });
      }
      if (busyKey || commitBusy) {
        return;
      }
      setBusyKey(row.key);
      setNotice(null);
      const outcome = await requestRowMutation({
        agentId,
        sessionId,
        snapshot,
        row,
        action,
      });
      if (!outcome.ok) {
        setNotice({ tone: 'destructive', message: outcome.error });
      } else {
        adopt(outcome.response);
      }
      setBusyKey(null);
    },
    [adopt, agentId, busyKey, commitBusy, sessionId, snapshot],
  );

  const stage = useCallback(
    (row: GitRow) => {
      void mutateRow(row, (request) => gitApi.gitStage(request));
    },
    [mutateRow],
  );

  const unstage = useCallback(
    (row: GitRow) => {
      void mutateRow(row, (request) => gitApi.gitUnstage(request));
    },
    [mutateRow],
  );

  const commit = useCallback(
    async (message: string): Promise<boolean> => {
      if (!agentId || !sessionId || !snapshot) {
        setNotice({ tone: 'destructive', message: LOADING_NOTICE });
        return false;
      }
      if (commitBusy) {
        return false;
      }

      const snapshotToken = snapshot.token;
      const previous = pendingCommit.current;
      const requestId =
        previous &&
        previous.message === message &&
        previous.snapshot === snapshotToken
          ? previous.requestId
          : newRequestId();
      pendingCommit.current = { message, snapshot: snapshotToken, requestId };

      setCommitBusy(true);
      setNotice(null);
      try {
        const response = await gitApi.gitCreateCommit({
          agent_id: agentId,
          session: sessionId,
          expectedSnapshot: snapshotToken,
          message,
          requestId,
        });
        const created = adopt(response);
        if (created) {
          pendingCommit.current = null;
        }
        return created;
      } catch (error) {
        // Keep `pendingCommit`: a resubmit of the same message against the same
        // reviewed state is the retry the idempotency key exists for.
        setNotice({ tone: 'destructive', message: transportMessage(error) });
        return false;
      } finally {
        setCommitBusy(false);
      }
    },
    [adopt, agentId, commitBusy, sessionId, snapshot],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    busyKey,
    commitBusy,
    notice,
    dismissNotice,
    stage,
    unstage,
    commit,
  };
}
