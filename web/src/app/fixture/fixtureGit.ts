import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import type {
  GitBranchesResponse,
  GitCommit,
  GitCommitResponse,
  GitCreateCommitResponse,
  GitDiffResponse,
  GitFileDiff,
  GitFilePreview,
  GitLogResponse,
  GitMutationResponse,
  GitPreviewResponse,
  GitSnapshot,
  GitStatus,
  GitStatusResponse,
  GitWorktreesResponse,
} from '@/capabilities/git';
import { FIXTURE_AGENTS } from './fixtureData';

/**
 * Deterministic controls the `git=overlap` scenario exposes to its Case.
 *
 * This is input, not rendering: the Case chooses when the older read settles
 * and can assert how many reads were actually started (no polling).
 */
type FixtureGitOverlapWindow = Window & {
  fixtureGitOverlap?: {
    requests: number;
    olderSettled: boolean;
    releaseOlder: () => void;
  };
  /** Every `git.diff` path this surface has been asked for, in order. */
  fixtureGitDiffRequests?: readonly string[];
};

/**
 * Deterministic controls the `git=selection-overlap` scenario exposes (#2972).
 *
 * The first diff/preview read is held; later reads answer the newer repository
 * state immediately. The Case releases the held answer to prove it can no
 * longer replace the newer selection, whether the user reselected the same row
 * or moved to another path/Session.
 */
type FixtureGitSelectionOverlapWindow = Window & {
  fixtureGitSelectionOverlap?: {
    diffRequests: () => number;
    previewRequests: () => number;
    olderDiffSettled: () => boolean;
    olderPreviewSettled: () => boolean;
    releaseOlderDiff: (fail?: boolean) => void;
    releaseOlderPreview: (fail?: boolean) => void;
  };
};

/**
 * Deterministic controls the `git=mutation-overlap` scenario exposes (#3327).
 *
 * A stage on the first Session is held until the Case releases it; the Case
 * switches to the second Session before releasing, so a late A answer that
 * still reaches the mounted view must not replace B.
 */
type FixtureGitMutationOverlapWindow = Window & {
  fixtureGitMutationOverlap?: {
    requests: () => number;
    settled: () => boolean;
    release: (fail?: boolean) => void;
  };
};

/** One recorded commit read: the target it was addressed to and the OID it named. */
type FixtureGitHistoryRequest = {
  agent_id: string;
  session: string;
  oid: string;
};

/** One recorded commit-sourced diff read, including the path it asked for. */
type FixtureGitHistoryDiffRequest = FixtureGitHistoryRequest & { path: string };

/**
 * How the held older read settles: the page it was going to answer with, a
 * transport rejection, or a fulfilled non-ok domain answer. The last is a
 * normal answer — the directory that was a repository no longer is — and the
 * hook must treat it as `describeUnavailable` copy rather than a rejection
 * (#4116).
 */
type HistoryOverlapRelease = 'page' | 'reject' | 'not_a_repository';

/**
 * Deterministic controls the `git=history-overlap` scenario exposes (#3751),
 * extended with request evidence for the selection-ownership Case (#3767)
 * and a rejected continuation for the failure-feedback Case (#4116).
 *
 * The first older page is held until the Case releases it. The Case can switch
 * Session or refresh the first page first, then assert the held answer changed
 * nothing — no timer decides when the stale continuation settles. Detail and
 * diff reads are recorded with the target they were addressed to and the OID
 * they named, so a Case can prove the successor was never asked about the
 * predecessor's commit. Releasing with `reject` rejects the held read instead
 * of answering it, and `not_a_repository` answers it with a fulfilled non-ok
 * domain answer — the two failure shapes the hook must surface — so a Case can
 * prove a continuation failure is visible and retryable without an unhandled
 * rejection.
 */
type FixtureGitHistoryOverlapWindow = Window & {
  fixtureGitHistoryOverlap?: {
    /** How many first pages this Session has been served (refresh increments). */
    firstPageRequests: (session: string) => number;
    olderRequests: () => number;
    olderSettled: () => boolean;
    releaseOlder: (outcome?: HistoryOverlapRelease) => void;
    /** Every `git.commit` read, in order, with its target and OID. */
    commitRequests: () => readonly FixtureGitHistoryRequest[];
    /** Every commit-sourced `git.diff` read, in order. */
    diffRequests: () => readonly FixtureGitHistoryDiffRequest[];
  };
};

/**
 * The plugin-surface boilerplate shared by the Git fixture scenarios.
 *
 * The real directory is filled by `AgentsPlugin` from the agent list; the
 * fixture has no agent list request, so it fills the same directory from the
 * same `FIXTURE_AGENTS` the rest of the fixture renders. Built with the same
 * `manifestsOf`, so the fixture cannot present a directory the app would not.
 */
function fixtureGitPluginSurface(
  request: <T>(type: string, payload: Record<string, unknown>) => Promise<T>,
): PluginSurface {
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));
  return {
    connectionState: 'connected',
    protocols,
    request,
    send(): void {},
    subscribe(): () => void {
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(): () => void {
      return () => {};
    },
  };
}

interface FixtureRepoState {
  scenario: string;
  status: GitStatusResponse;
  snapshot: GitSnapshot;
  snapshotEpoch: number;
  headEpoch: number;
}

function createFixtureRepoState(
  scenario: string,
  status: GitStatusResponse,
): FixtureRepoState {
  return {
    scenario,
    status,
    snapshot:
      status.state === 'ok'
        ? status.snapshot
        : fixtureSnapshot('fixture-unavailable-0', null),
    snapshotEpoch: 0,
    headEpoch: 0,
  };
}

/**
 * Apply one write unit to the canned repository.
 *
 * Mirrors the agent's contract: the reviewed token is checked first, and a
 * success answers with the authoritative new status and snapshot. This is a
 * real state machine because the browser Case must be able to see a stale
 * review and an authoritative post-state, not a stub that always says ok.
 */
function mutateFixtureRepository(
  repo: FixtureRepoState,
  type: string,
  payload: Record<string, unknown>,
): GitMutationResponse | GitCreateCommitResponse {
  if (repo.status.state !== 'ok') {
    return {
      state: 'not_a_repository',
      message: 'This Session is not in a git repository.',
    };
  }
  if (String(payload.expected_snapshot ?? '') !== repo.snapshot.token) {
    return {
      state: 'repository_changed',
      message: 'The repository changed after it was reviewed.',
      snapshot: repo.snapshot,
      status: repo.status.status,
      truncated: false,
      truncated_bytes: 0,
    };
  }

  const path = String(payload.path ?? '');
  const status = repo.status.status;

  const accept = (next: GitStatus, head: string | null = repo.snapshot.head ?? null) => {
    repo.snapshotEpoch += 1;
    repo.snapshot = fixtureSnapshot(
      `fixture-${repo.scenario}-${repo.snapshotEpoch}`,
      head,
    );
    repo.status = {
      state: 'ok',
      status: next,
      // Preserve the repository the scenario declared; the shared sample
      // statuses all use FIXTURE_ROOT, while per-Session scenarios do not.
      root: repo.status.state === 'ok' ? repo.status.root : FIXTURE_ROOT,
      snapshot: repo.snapshot,
      truncated: false,
      truncated_bytes: 0,
    };
    return {
      state: 'ok' as const,
      snapshot: repo.snapshot,
      status: next,
      truncated: false,
      truncated_bytes: 0,
    };
  };

  if (type === 'git.stage') {
    const isUntracked = status.untracked.includes(path);
    const tracked = status.modified.some((file) => file.path === path);
    if (!isUntracked && !tracked) {
      return { state: 'refused', message: `\`${path}\` has no unstaged change to stage.` };
    }
    const modified = status.modified.map((file) =>
      file.path === path ? { ...file, staged: true, unstaged: false } : file,
    );
    return accept({
      ...status,
      modified: isUntracked
        ? [...modified, { path, kind: 'added', staged: true, unstaged: false }]
        : modified,
      untracked: status.untracked.filter((candidate) => candidate !== path),
    });
  }

  if (type === 'git.unstage') {
    const file = status.modified.find(
      (candidate) => candidate.path === path && candidate.staged,
    );
    if (!file) {
      return { state: 'refused', message: `\`${path}\` has no staged change to unstage.` };
    }
    return accept({
      ...status,
      modified:
        file.kind === 'added'
          ? status.modified.filter((candidate) => candidate.path !== path)
          : status.modified.map((candidate) =>
              candidate.path === path
                ? { ...candidate, staged: false, unstaged: true }
                : candidate,
            ),
      untracked: file.kind === 'added' ? [...status.untracked, path] : status.untracked,
    });
  }

  // git.create-commit
  if (!status.modified.some((file) => file.staged)) {
    return { state: 'refused', message: 'There are no staged changes to commit.' };
  }
  repo.headEpoch += 1;
  const head = `fixture-head-commit-${repo.headEpoch}`;
  const accepted = accept(
    { ...status, modified: status.modified.filter((file) => !file.staged) },
    head,
  );
  return {
    ...accepted,
    commit: { oid: head, author: 'Fixture Dev <dev@example.com>' },
  };
}

/**
 * A canned git backend for the fixture route.
 *
 * The fixture is offline, so the git capability has nothing to talk to. This
 * stands in for the agent's `git.*` answers with deterministic data,
 * which is what lets the canonical route render the view at all — and therefore
 * what lets e2e assert the Git Changes surface against real DOM rather
 * than against a jsdom mock.
 *
 * What it varies is the *repository*, never the component's state: a route
 * cannot ask for "the truncated view" or "the failure view" directly, only for
 * a repository that produces one. A fixture that could name a state would let a
 * test assert a rendering the app never decided on.
 *
 * Answers must be shapes the real agent can produce. A field the agent derives
 * from a request or a default is copied from *there* — its default count, its
 * clamping — not derived from this file's own sample data, because a fixture
 * that invents an answer makes the view render a state the product never has.
 *
 *   /#/fixture/workspace?capability=git              → a repository with changes
 *   /#/fixture/workspace?capability=git&git=clean    → a clean working tree
 *   /#/fixture/workspace?capability=git&git=many     → a long change list, for
 *     end-of-scroll geometry (#4115)
 *   /#/fixture/workspace?capability=git&git=diff-states → one file of each diff
 *     state the renderer owns: ordinary, binary, mode-only, empty, truncated,
 *     malformed/raw-fallback, and one longer than the pane
 *   /#/fixture/workspace?capability=git&git=long-lists → enough branches and
 *     worktrees to overflow the nested App sections (#4188)
 *   /#/fixture/workspace?capability=git&git=preview-states → untracked,
 *     conflicted, binary, truncated, missing and changed previews
 *   /#/fixture/workspace?capability=git&git=overlap  → the first status read is
 *     held until the Case releases it, so a manual Refresh can answer first
 *     with the newer repository state (#2787)
 *   /#/fixture/workspace?capability=git&git=history-overlap → two Sessions with
 *     distinct pageable histories; the first older page is held until the Case
 *     releases it, after a Session move or a replaced first page (#3751), and
 *     can be released as a rejection so a continuation failure is observable
 *     (#4116)
 */
export function fixtureGitSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('git') ?? 'changed';
  if (scenario === 'selection-overlap') {
    return selectionOverlapGitSurface();
  }
  if (scenario === 'mutation-overlap') {
    return mutationOverlapGitSurface();
  }
  if (scenario === 'history-overlap') {
    return historyOverlapGitSurface();
  }
  const status =
    scenario === 'clean'
      ? CLEAN_STATUS
      : scenario === 'many'
        ? MANY_CHANGES_STATUS
        : scenario === 'diff-states'
          ? DIFF_STATE_STATUS
          : scenario === 'preview-states'
            ? PREVIEW_STATE_STATUS
            : CHANGED_STATUS;
  // The write path is a small state machine: the fixture must be able to show
  // a stale review and an authoritative post-state, not a stub that always
  // answers ok. The state lives in one object so the request handler stays a
  // router rather than a second implementation.
  const repo = createFixtureRepoState(scenario, status);
  /** Every `git.status` read this surface has been asked for. */
  let statusRequests = 0;
  /** Every `git.diff` path this surface has been asked for, in order. */
  const diffRequests: string[] = [];
  /** Resolves the held older read in the `overlap` scenario. */
  let releaseOlderStatus: (() => void) | null = null;
  let olderSettled = false;

  /**
   * Publish the overlap controls on the real browser window.
   *
   * The Case needs to say *when* the older read resolves, not wait a guessed
   * amount of time. `olderSettled` flips only after a macrotask, so a Case that
   * waits for it knows the stale continuation has had its chance to render.
   * Guarded for the node-env unit project, which has no `window`.
   */
  const publishOverlap = () => {
    if (typeof window === 'undefined') {
      return;
    }
    (window as FixtureGitOverlapWindow).fixtureGitOverlap = {
      requests: statusRequests,
      olderSettled,
      releaseOlder: () => {
        releaseOlderStatus?.();
        setTimeout(() => {
          olderSettled = true;
          publishOverlap();
        }, 0);
      },
    };
  };

  // The real directory is filled by `AgentsPlugin` from the agent list; the
  // fixture has no agent list request, so it fills the same directory from the
  // same `FIXTURE_AGENTS` the rest of the fixture renders. Built with the same
  // `manifestsOf`, so the fixture cannot present a directory the app would not.
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      if (type === 'git.status') {
        statusRequests += 1;
        if (scenario === 'overlap') {
          publishOverlap();
          if (statusRequests === 1) {
            // The mount read: held in flight, answering with the older
            // repository state when the Case releases it.
            return new Promise<T>((resolve) => {
              releaseOlderStatus = () => resolve(CLEAN_STATUS as T);
              publishOverlap();
            });
          }
          // The manual Refresh: the newer repository state, answered first.
          return Promise.resolve(CHANGED_STATUS as T);
        }
        return Promise.resolve(repo.status as T);
      }
      if (type === 'git.stage' || type === 'git.unstage' || type === 'git.create-commit') {
        return Promise.resolve(mutateFixtureRepository(repo, type, payload) as T);
      }
      if (type === 'git.diff') {
        diffRequests.push(String(payload.path));
        if (typeof window !== 'undefined') {
          (window as FixtureGitOverlapWindow).fixtureGitDiffRequests = diffRequests;
        }
        return Promise.resolve(
          diffFor(String(payload.path), scenario, repo.snapshot) as T,
        );
      }
      if (type === 'git.preview') {
        return Promise.resolve(
          previewFor(String(payload.path), String(payload.expected), scenario, payload.want === 'media' ? 'media' : 'text') as T,
        );
      }
      if (type === 'git.log') {
        return Promise.resolve(historyFor(payload.limit) as T);
      }
      if (type === 'git.commit') {
        return Promise.resolve(commitDetailFor(String(payload.oid)) as T);
      }
      if (type === 'git.branches') {
        return Promise.resolve(
          (scenario === 'long-lists'
            ? longBranchesFor(payload.limit)
            : branchesFor(payload.limit)) as T,
        );
      }
      if (type === 'git.worktrees') {
        return Promise.resolve((scenario === 'long-lists' ? LONG_WORKTREES : WORKTREES) as T);
      }
      return Promise.reject(new Error(`fixture git surface does not answer ${type}`));
    },
    send(): void {},
    subscribe(): () => void {
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(): () => void {
      return () => {};
    },
  };
}

/**
 * The `git=selection-overlap` surface (#2972).
 *
 * The first diff/preview read is held; every later read answers the newer
 * repository state immediately. The Case releases the held answer to prove the
 * hook's request identity fence, not a timer.
 */
function selectionOverlapGitSurface(): PluginSurface {
  const diffRequests: string[] = [];
  const previewRequests: string[] = [];
  let settleHeldDiff: ((value: GitDiffResponse) => void) | null = null;
  let failHeldDiff: ((reason: Error) => void) | null = null;
  let heldDiffPath: string | null = null;
  let settleHeldPreview: ((value: GitPreviewResponse) => void) | null = null;
  let failHeldPreview: ((reason: Error) => void) | null = null;
  let heldPreviewPath: string | null = null;
  let olderDiffSettled = false;
  let olderPreviewSettled = false;

  const publish = () => {
    if (typeof window === 'undefined') {
      return;
    }
    (window as FixtureGitSelectionOverlapWindow).fixtureGitSelectionOverlap = {
      diffRequests: () => diffRequests.length,
      previewRequests: () => previewRequests.length,
      olderDiffSettled: () => olderDiffSettled,
      olderPreviewSettled: () => olderPreviewSettled,
      releaseOlderDiff: (fail = false) => {
        const settle = settleHeldDiff;
        const reject = failHeldDiff;
        const path = heldDiffPath;
        settleHeldDiff = null;
        failHeldDiff = null;
        heldDiffPath = null;
        if (!settle || !reject || path === null) {
          return;
        }
        if (fail) {
          reject(new Error('the older selection diff failed'));
        } else {
          settle(selectionOverlapDiff(path, 'OLD'));
        }
        setTimeout(() => {
          olderDiffSettled = true;
          publish();
        }, 0);
      },
      releaseOlderPreview: (fail = false) => {
        const settle = settleHeldPreview;
        const reject = failHeldPreview;
        const path = heldPreviewPath;
        settleHeldPreview = null;
        failHeldPreview = null;
        heldPreviewPath = null;
        if (!settle || !reject || path === null) {
          return;
        }
        if (fail) {
          reject(new Error('the older selection preview failed'));
        } else {
          settle(selectionOverlapPreview(path, 'OLD'));
        }
        setTimeout(() => {
          olderPreviewSettled = true;
          publish();
        }, 0);
      },
    };
  };
  publish();

  return fixtureGitPluginSurface(
    <T>(type: string, payload: Record<string, unknown>): Promise<T> => {
      if (type === 'git.status') {
        return Promise.resolve(SELECTION_OVERLAP_STATUS as T);
      }
      if (type === 'git.diff') {
        const path = String(payload.path);
        diffRequests.push(path);
        publish();
        if (diffRequests.length === 1) {
          heldDiffPath = path;
          return new Promise<T>((resolve, reject) => {
            settleHeldDiff = (value) => resolve(value as T);
            failHeldDiff = reject;
            publish();
          });
        }
        return Promise.resolve(selectionOverlapDiff(path, 'NEW') as T);
      }
      if (type === 'git.preview') {
        const path = String(payload.path);
        previewRequests.push(path);
        publish();
        if (previewRequests.length === 1) {
          heldPreviewPath = path;
          return new Promise<T>((resolve, reject) => {
            settleHeldPreview = (value) => resolve(value as T);
            failHeldPreview = reject;
            publish();
          });
        }
        return Promise.resolve(selectionOverlapPreview(path, 'NEW') as T);
      }
      if (type === 'git.log') {
        return Promise.resolve(historyFor(payload.limit) as T);
      }
      if (type === 'git.commit') {
        return Promise.resolve(commitDetailFor(String(payload.oid)) as T);
      }
      if (type === 'git.branches') {
        return Promise.resolve(branchesFor(payload.limit) as T);
      }
      if (type === 'git.worktrees') {
        return Promise.resolve(WORKTREES as T);
      }
      return Promise.reject(new Error(`fixture git surface does not answer ${type}`));
    },
  );
}

/**
 * The `git=mutation-overlap` surface (#3327).
 *
 * Two Sessions have distinct repositories. The first stage/unstage/commit for
 * the first Session is held until the Case releases it; the Case switches to
 * the second Session first. A late answer that still reaches the mounted view
 * must not replace B's repository, notice, busy state, or commit draft.
 */
function mutationOverlapGitSurface(): PluginSurface {
  const SESSION_A = 'devbox-01:fix-terminal-reconnect';
  const SESSION_B = 'devbox-01:design-system';
  const repos = new Map<string, FixtureRepoState>([
    [SESSION_A, createFixtureRepoState('mutation-a', MUTATION_OVERLAP_A)],
    [SESSION_B, createFixtureRepoState('mutation-b', MUTATION_OVERLAP_B)],
  ]);
  let requests = 0;
  let settled = false;
  let held: {
    repo: FixtureRepoState;
    type: string;
    payload: Record<string, unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  } | null = null;

  const publish = () => {
    if (typeof window === 'undefined') {
      return;
    }
    (window as FixtureGitMutationOverlapWindow).fixtureGitMutationOverlap = {
      requests: () => requests,
      settled: () => settled,
      release: (fail = false) => {
        const current = held;
        held = null;
        if (!current) {
          return;
        }
        if (fail) {
          current.reject(new Error('the held stage failed'));
        } else {
          current.resolve(mutateFixtureRepository(current.repo, current.type, current.payload));
        }
        setTimeout(() => {
          settled = true;
          publish();
        }, 0);
      },
    };
  };
  publish();

  const repoFor = (payload: Record<string, unknown>) =>
    repos.get(String(payload.session ?? '')) ?? repos.get(SESSION_A)!;

  return fixtureGitPluginSurface(
    <T>(type: string, payload: Record<string, unknown>): Promise<T> => {
      if (type === 'git.status') {
        return Promise.resolve(repoFor(payload).status as T);
      }
      if (type === 'git.stage' || type === 'git.unstage' || type === 'git.create-commit') {
        const repo = repoFor(payload);
        // Hold the first mutation for the first Session; every later request
        // answers immediately so B's own work can complete normally.
        if (String(payload.session ?? '') === SESSION_A && !settled) {
          requests += 1;
          publish();
          return new Promise<T>((resolve, reject) => {
            held = {
              repo,
              type,
              payload,
              resolve: (value) => resolve(value as T),
              reject,
            };
            publish();
          });
        }
        return Promise.resolve(mutateFixtureRepository(repo, type, payload) as T);
      }
      if (type === 'git.diff') {
        return Promise.resolve(
          diffFor(String(payload.path), 'changed', repoFor(payload).snapshot) as T,
        );
      }
      if (type === 'git.preview') {
        return Promise.resolve(
          previewFor(
            String(payload.path),
            String(payload.expected),
            'changed',
            payload.want === 'media' ? 'media' : 'text',
          ) as T,
        );
      }
      if (type === 'git.log') {
        return Promise.resolve(historyFor(payload.limit) as T);
      }
      if (type === 'git.commit') {
        return Promise.resolve(commitDetailFor(String(payload.oid)) as T);
      }
      if (type === 'git.branches') {
        return Promise.resolve(branchesFor(payload.limit) as T);
      }
      if (type === 'git.worktrees') {
        return Promise.resolve(WORKTREES as T);
      }
      return Promise.reject(new Error(`fixture git surface does not answer ${type}`));
    },
  );
}

/**
 * Everything the `history-overlap` surface remembers between requests.
 *
 * The request evidence arrays are part of it because the Case reasons about
 * the exact target and OID a read named, not about a call count alone (#3767).
 */
interface HistoryOverlapState {
  firstPageRequests: Map<string, number>;
  cursors: Map<string, { session: string; generation: number }>;
  servedCommits: Map<string, GitCommit>;
  commitRequests: FixtureGitHistoryRequest[];
  diffRequests: FixtureGitHistoryDiffRequest[];
  olderRequests: number;
  olderSettled: boolean;
  held: {
    session: string;
    generation: number;
    resolve: (value: GitLogResponse) => void;
    reject: (reason: Error) => void;
  } | null;
}

/** Register every commit a page listed, so `git.commit` answers a real row. */
function rememberHistoryOverlapPage(
  state: HistoryOverlapState,
  page: GitLogResponse,
): GitLogResponse {
  if (page.state === 'ok') {
    for (const commit of page.history.commits) {
      state.servedCommits.set(commit.hash, commit);
    }
  }
  return page;
}

/** Serve a first page or a cursor-addressed continuation, holding the first. */
function historyOverlapLog(
  state: HistoryOverlapState,
  payload: Record<string, unknown>,
  publish: () => void,
): Promise<GitLogResponse> {
  const session = String(payload.session ?? '');
  const before = typeof payload.before === 'string' ? payload.before : null;
  if (!before) {
    const generation = (state.firstPageRequests.get(session) ?? 0) + 1;
    state.firstPageRequests.set(session, generation);
    const cursor = historyOverlapCursorFor(session, generation);
    state.cursors.set(cursor, { session, generation });
    publish();
    return Promise.resolve(
      rememberHistoryOverlapPage(
        state,
        historyOverlapFirstPage(session, generation, cursor),
      ),
    );
  }
  // Answer what the *cursor* names, not merely the Session the request
  // claims: a continuation that rolled back to another list's cursor is
  // then visibly that list's page, which is what the Case must catch.
  const fromCursor = state.cursors.get(before) ?? { session, generation: 1 };
  state.olderRequests += 1;
  publish();
  if (state.olderRequests === 1) {
    return new Promise<GitLogResponse>((resolve, reject) => {
      state.held = {
        session: fromCursor.session,
        generation: fromCursor.generation,
        resolve,
        reject,
      };
      publish();
    });
  }
  return Promise.resolve(
    rememberHistoryOverlapPage(
      state,
      historyOverlapOlderPage(fromCursor.session, fromCursor.generation),
    ),
  );
}

/** Record a commit-sourced file patch read, then answer it. */
function historyOverlapDiff(
  state: HistoryOverlapState,
  payload: Record<string, unknown>,
  publish: () => void,
): Promise<GitDiffResponse> {
  const source = payload.source as { kind?: string; oid?: string } | undefined;
  if (source?.kind === 'commit') {
    state.diffRequests.push({
      agent_id: String(payload.agent_id ?? ''),
      session: String(payload.session ?? ''),
      oid: String(source.oid ?? ''),
      path: String(payload.path ?? ''),
    });
    publish();
  }
  return Promise.resolve(
    diffFor(
      String(payload.path),
      'changed',
      // The same snapshot `CHANGED_STATUS` declares; the union type does
      // not let the fixture read it off the answer directly.
      fixtureSnapshot('fixture-changed-0', 'fixture-head-changed'),
    ),
  );
}

/** Record a detail read and resolve only a commit a served page listed. */
function historyOverlapDetail(
  state: HistoryOverlapState,
  payload: Record<string, unknown>,
  publish: () => void,
): Promise<GitCommitResponse> {
  const request: FixtureGitHistoryRequest = {
    agent_id: String(payload.agent_id ?? ''),
    session: String(payload.session ?? ''),
    oid: String(payload.oid ?? ''),
  };
  state.commitRequests.push(request);
  publish();
  const commit = state.servedCommits.get(request.oid);
  if (!commit) {
    // The agent validates the object name against the Session's repository;
    // a fixture must not invent a commit it never served.
    return Promise.resolve({
      state: 'error',
      message: `unknown revision: ${request.oid}`,
    });
  }
  return Promise.resolve(historyOverlapCommitDetail(commit));
}

/**
 * The `git=history-overlap` surface (#3751), with selection request evidence
 * (#3767).
 *
 * Two Sessions have distinct histories, and every page is addressable by the
 * cursor the previous page handed out: a first page is served per Session and
 * per generation (a refresh is the next generation), while an older page is
 * derived from the cursor's session and generation. The first older request is
 * held until the Case releases it, so the Case — not a timer — decides whether
 * a stale continuation is even offered a chance to render.
 */
function historyOverlapGitSurface(): PluginSurface {
  const state: HistoryOverlapState = {
    firstPageRequests: new Map<string, number>(),
    // A cursor is an opaque commit OID on the wire; the fixture records which
    // page handed it out so an older request is answered from the cursor.
    cursors: new Map<string, { session: string; generation: number }>(),
    servedCommits: new Map<string, GitCommit>(),
    commitRequests: [],
    diffRequests: [],
    olderRequests: 0,
    olderSettled: false,
    held: null,
  };

  const publish = () => {
    if (typeof window === 'undefined') {
      return;
    }
    (window as FixtureGitHistoryOverlapWindow).fixtureGitHistoryOverlap = {
      firstPageRequests: (session: string) => state.firstPageRequests.get(session) ?? 0,
      olderRequests: () => state.olderRequests,
      olderSettled: () => state.olderSettled,
      releaseOlder: (outcome: HistoryOverlapRelease = 'page') => {
        const current = state.held;
        state.held = null;
        if (!current) {
          return;
        }
        if (outcome === 'reject') {
          // A transport failure is a rejected read, not an error-shaped answer:
          // the hook's catch path is what the Case must observe (#4116).
          current.reject(new Error('the held older page failed'));
        } else if (outcome === 'not_a_repository') {
          // A fulfilled non-ok answer is a domain answer — the directory that
          // was a repository no longer is — and takes the hook's non-ok path,
          // not its catch path (#4116).
          current.resolve({
            state: 'not_a_repository',
            message: 'the Session directory is no longer a git repository',
          });
        } else {
          current.resolve(
            rememberHistoryOverlapPage(
              state,
              historyOverlapOlderPage(current.session, current.generation),
            ),
          );
        }
        setTimeout(() => {
          state.olderSettled = true;
          publish();
        }, 0);
      },
      commitRequests: () => state.commitRequests,
      diffRequests: () => state.diffRequests,
    };
  };
  publish();

  return fixtureGitPluginSurface(
    <T>(type: string, payload: Record<string, unknown>): Promise<T> => {
      if (type === 'git.status') {
        return Promise.resolve(CHANGED_STATUS as T);
      }
      if (type === 'git.log') {
        return historyOverlapLog(state, payload, publish).then((value) => value as T);
      }
      if (type === 'git.diff') {
        return historyOverlapDiff(state, payload, publish).then((value) => value as T);
      }
      if (type === 'git.preview') {
        return Promise.resolve(
          previewFor(
            String(payload.path),
            String(payload.expected),
            'changed',
            payload.want === 'media' ? 'media' : 'text',
          ) as T,
        );
      }
      if (type === 'git.commit') {
        return historyOverlapDetail(state, payload, publish).then((value) => value as T);
      }
      if (type === 'git.branches') {
        return Promise.resolve(branchesFor(payload.limit) as T);
      }
      if (type === 'git.worktrees') {
        return Promise.resolve(WORKTREES as T);
      }
      return Promise.reject(new Error(`fixture git surface does not answer ${type}`));
    },
  );
}

/**
 * The second of the two Sessions the `history-overlap` scenario moves between;
 * the first is the fixture's default (`devbox-01:fix-terminal-reconnect`).
 */
const HISTORY_OVERLAP_B = 'devbox-01:design-system';

/**
 * One page is the agent's default count for a request that names no limit —
 * `DEFAULT_LOG_LIMIT` in `crates/nession-git/src/security.rs`. A page smaller
 * than that with a continuation is not a shape the agent produces.
 */
const HISTORY_OVERLAP_PAGE = 50;

function historyOverlapLabel(session: string): 'A' | 'B' {
  return session === HISTORY_OVERLAP_B ? 'B' : 'A';
}

function historyOverlapHash(
  session: string,
  generation: number,
  index: number,
): string {
  const seed = `${historyOverlapLabel(session)}${generation}:${index}`;
  let hash = '';
  for (let offset = 0; hash.length < 40; offset += 1) {
    const code =
      seed.charCodeAt(offset % seed.length) + offset * 13 + generation * 7 + index * 3;
    hash += (code % 256).toString(16).padStart(2, '0');
  }
  return hash.slice(0, 40);
}

function historyOverlapCommit(
  session: string,
  generation: number,
  index: number,
  subject: string,
): GitCommit {
  const hash = historyOverlapHash(session, generation, index);
  return {
    hash,
    short_hash: hash.slice(0, 7),
    author: 'Fixture Dev',
    relative_date: '1 hour ago',
    date: '2026-11-16T10:00:00+08:00',
    subject: `${historyOverlapLabel(session)} ${subject}`,
    refs: '',
  };
}

/**
 * One served History row's detail, with a changed file so the selection Case
 * can cover the file selection and its commit-sourced `git.diff` (#3767).
 *
 * The file is derived from the row's own A/B identity: the detail and the diff
 * are answers about the same commit the list offered, not a second canned
 * object that could disagree with it.
 */
function historyOverlapCommitDetail(commit: GitCommit): GitCommitResponse {
  const label = commit.subject.startsWith('B ') ? 'b' : 'a';
  return {
    state: 'ok',
    commit: {
      oid: commit.hash,
      short_oid: commit.short_hash,
      parents: [],
      author: commit.author,
      author_date: commit.date,
      committer: commit.author,
      commit_date: commit.date,
      subject: commit.subject,
      body: '',
      decorations: '',
      files: [
        {
          path: `src/${label}-history-overlap.ts`,
          status: 'M',
          binary: false,
        },
      ],
      files_truncated: false,
      files_truncated_bytes: 0,
      message_truncated: false,
      message_truncated_bytes: 0,
      merge_diff_parent: '',
    },
  };
}

function historyOverlapFirstPage(
  session: string,
  generation: number,
  cursor: string,
): GitLogResponse {
  const commits = Array.from({ length: HISTORY_OVERLAP_PAGE }, (_, offset) =>
    historyOverlapCommit(
      session,
      generation,
      offset + 1,
      `first page ${generation} commit ${offset + 1}`,
    ),
  );
  return {
    state: 'ok',
    history: {
      commits,
      limit: HISTORY_OVERLAP_PAGE,
      truncated_bytes: 0,
      truncated: false,
      end_of_history: false,
      next_cursor: cursor,
    },
  };
}

function historyOverlapOlderPage(
  session: string,
  generation: number,
): GitLogResponse {
  const commits = Array.from({ length: HISTORY_OVERLAP_PAGE }, (_, offset) =>
    historyOverlapCommit(
      session,
      generation,
      HISTORY_OVERLAP_PAGE + offset + 1,
      `older page ${generation} commit ${offset + 1}`,
    ),
  );
  return {
    state: 'ok',
    history: {
      commits,
      limit: HISTORY_OVERLAP_PAGE,
      truncated_bytes: 0,
      truncated: false,
      end_of_history: true,
    },
  };
}

/**
 * The cursor a first page hands out: an opaque commit OID on the wire, stable
 * for its Session and generation and distinct from the page's rows.
 */
function historyOverlapCursorFor(session: string, generation: number): string {
  return historyOverlapHash(session, generation, 0);
}

/** The work tree the fixture pretends to be in — a Peek names its basename. */
const FIXTURE_ROOT = '/Users/dev/code/nession-capsule';

/** The first Session's repository for the `mutation-overlap` scenario. */
const MUTATION_OVERLAP_A: GitStatusResponse = {
  state: 'ok',
  root: '/Users/dev/code/repo-a',
  snapshot: fixtureSnapshot('fixture-mutation-a-0', 'fixture-head-a'),
  truncated: false,
  truncated_bytes: 0,
  status: {
    branch: 'feat/a',
    detached: false,
    upstream: 'origin/feat/a',
    ahead: 0,
    behind: 0,
    modified: [
      { path: 'a-staged.ts', kind: 'modified', staged: true, unstaged: false },
      { path: 'a.ts', kind: 'modified', staged: false, unstaged: true },
    ],
    untracked: [],
    unmerged: [],
  },
};

/** The second Session's repository; distinct branch, files and root. */
const MUTATION_OVERLAP_B: GitStatusResponse = {
  state: 'ok',
  root: '/Users/dev/code/repo-b',
  snapshot: fixtureSnapshot('fixture-mutation-b-0', 'fixture-head-b'),
  truncated: false,
  truncated_bytes: 0,
  status: {
    branch: 'feat/b',
    detached: false,
    upstream: 'origin/feat/b',
    ahead: 0,
    behind: 0,
    modified: [
      { path: 'b-staged.ts', kind: 'modified', staged: true, unstaged: false },
      { path: 'b.ts', kind: 'modified', staged: false, unstaged: true },
    ],
    untracked: [],
    unmerged: [],
  },
};


/** A snapshot identity for a canned state; only equality is meaningful. */
function fixtureSnapshot(token: string, head: string | null): GitSnapshot {
  return { token, head, root: FIXTURE_ROOT };
}

const CLEAN_STATUS: GitStatusResponse = {
  state: 'ok',
  root: FIXTURE_ROOT,
  snapshot: fixtureSnapshot('fixture-clean-0', 'fixture-head-clean'),
  truncated: false,
  truncated_bytes: 0,
  status: {
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    modified: [],
    untracked: [],
    unmerged: [],
  },
};

/**
 * A branch ahead of its upstream, one staged and one unstaged change, an
 * untracked file, and a binary — between them the shapes the view has to have
 * an answer for.
 */
const CHANGED_STATUS: GitStatusResponse = {
  state: 'ok',
  root: FIXTURE_ROOT,
  snapshot: fixtureSnapshot('fixture-changed-0', 'fixture-head-changed'),
  truncated: false,
  truncated_bytes: 0,
  status: {
    branch: 'feat/repo-status',
    detached: false,
    upstream: 'origin/feat/repo-status',
    ahead: 2,
    behind: 1,
    modified: [
      {
        path: 'web/src/capabilities/git/GitPlugin.ts',
        kind: 'modified',
        staged: false,
        unstaged: true,
      },
      {
        path: 'crates/nession-git/src/cmd.rs',
        kind: 'modified',
        staged: true,
        unstaged: false,
      },
      { path: 'assets/logo.png', kind: 'modified', staged: false, unstaged: true },
    ],
    untracked: ['web/src/capabilities/git/index.ts', 'notes.md'],
    unmerged: [],
  },
};

/**
 * A long, deterministic change list (#4115).
 *
 * The App Workspace endpoint Case must scroll a real Collection to its end;
 * three rows fit under the Capsule on a phone, so the fixture needs a working
 * tree whose list genuinely overflows. Every path is ordinary and every diff
 * resolves through `changedDiff`, so no new renderer state is introduced.
 */
const MANY_CHANGES_STATUS: GitStatusResponse = {
  state: 'ok',
  root: FIXTURE_ROOT,
  snapshot: fixtureSnapshot('fixture-many-0', 'fixture-head-many'),
  truncated: false,
  truncated_bytes: 0,
  status: {
    branch: 'feat/many-changes',
    detached: false,
    upstream: 'origin/feat/many-changes',
    ahead: 0,
    behind: 0,
    modified: Array.from({ length: 36 }, (_, index) => ({
      path: `src/many/change-${String(index).padStart(2, '0')}.ts`,
      kind: 'modified',
      staged: false,
      unstaged: true,
    })),
    untracked: [],
    unmerged: [],
  },
};

function changedDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1a2b3c4..5d6e7f8 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,4 +1,5 @@',
    " import type { TransportPlugin } from '@/platform/socket/types';",
    "+import type { GitStatusRequest } from './types';",
    ' ',
    ' export class GitPlugin implements TransportPlugin {',
    '-  readonly name = "claude-code";',
    '+  readonly name = "git";',
  ].join('\n');
}

/**
 * The repository for #2972's selection-overlap Case.
 *
 * One tracked row, two untracked rows and one conflicted row: enough to
 * reselect the same row, move to a different path, or move the Session while
 * the first read is still in flight. The answers themselves are held by the
 * surface, not by the repository, so this stays an input shape.
 */
const SELECTION_OVERLAP_STATUS: GitStatusResponse = {
  state: 'ok',
  root: FIXTURE_ROOT,
  snapshot: fixtureSnapshot('fixture-selection-overlap-0', 'fixture-head-selection'),
  truncated: false,
  truncated_bytes: 0,
  status: {
    branch: 'feat/selection-overlap',
    detached: false,
    upstream: 'origin/feat/selection-overlap',
    ahead: 0,
    behind: 0,
    modified: [
      {
        path: 'src/reselect.ts',
        kind: 'modified',
        staged: false,
        unstaged: true,
      },
    ],
    untracked: ['notes/reselect.ts', 'notes/reselect-other.ts'],
    unmerged: ['src/reselect-conflict.ts'],
  },
};

/**
 * One side of the #2972 race, with a marker the Case can assert in the DOM.
 *
 * The older answer is also marked truncated, so a stale publication is visible
 * even if a renderer chooses not to expose the patch text.
 */
function selectionOverlapDiff(path: string, marker: 'OLD' | 'NEW'): GitDiffResponse {
  const text = [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ' const before = 1;',
    `-const selection = "${marker}_DIFF_RESPONSE";`,
    `+const selection = "${marker}_DIFF_RESPONSE";`,
  ].join('\n');
  return {
    state: 'ok',
    diff: {
      path,
      text,
      binary: false,
      truncated: marker === 'OLD',
      truncated_bytes: marker === 'OLD' ? 4096 : 0,
    },
    snapshot: fixtureSnapshot('fixture-selection-overlap-0', 'fixture-head-selection'),
  };
}

function selectionOverlapPreview(path: string, marker: 'OLD' | 'NEW'): GitPreviewResponse {
  const text = path.endsWith('conflict.ts')
    ? `<<<<<<< HEAD\n${marker}_PREVIEW_RESPONSE ${path}\n=======\ntheirs\n>>>>>>> other\n`
    : `${marker}_PREVIEW_RESPONSE ${path}\n`;
  return readyPreview(path, text);
}

/**
 * One file per state the diff renderer has to answer for.
 *
 * This is the repository that produces those answers: the renderer still
 * decides what each one looks like. The truncated answer is a complete short
 * patch with the Agent's truncation flag set — exactly what a byte cap at a
 * hunk boundary produces — while the malformed answer has a hunk whose header
 * promises more lines than the body carries, the shape a cut in the middle of
 * a hunk produces.
 */
const DIFF_STATE_STATUS: GitStatusResponse = {
  state: 'ok',
  root: FIXTURE_ROOT,
  snapshot: fixtureSnapshot('fixture-diff-states-0', 'fixture-head-diff'),
  truncated: false,
  truncated_bytes: 0,
  status: {
    branch: 'feat/diff-rendering',
    detached: false,
    upstream: 'origin/feat/diff-rendering',
    ahead: 0,
    behind: 0,
    modified: [
      {
        path: 'web/src/capabilities/git/GitPlugin.ts',
        kind: 'modified',
        staged: false,
        unstaged: true,
      },
      { path: 'assets/logo.png', kind: 'modified', staged: false, unstaged: true },
      { path: 'mode/run.sh', kind: 'modified', staged: true, unstaged: false },
      { path: 'src/empty.txt', kind: 'modified', staged: false, unstaged: true },
      { path: 'src/large.ts', kind: 'modified', staged: false, unstaged: true },
      { path: 'src/long.ts', kind: 'modified', staged: false, unstaged: true },
      { path: 'src/malformed.ts', kind: 'modified', staged: false, unstaged: true },
    ],
    untracked: [],
    unmerged: [],
  },
};

/**
 * A repository with one row of every worktree-preview shape.
 *
 * `untracked` and `unmerged` are disjoint by construction: the Agent now
 * reports a conflicted path once, in `unmerged` only. The missing/changed
 * answers are races the reader can actually hit after selecting a row.
 */
const PREVIEW_STATE_STATUS: GitStatusResponse = {
  state: 'ok',
  root: FIXTURE_ROOT,
  snapshot: fixtureSnapshot('fixture-preview-states-0', 'fixture-head-preview'),
  truncated: false,
  truncated_bytes: 0,
  status: {
    branch: 'feat/file-preview',
    detached: false,
    upstream: 'origin/feat/file-preview',
    ahead: 0,
    behind: 0,
    modified: [
      { path: 'src/deleted.ts', kind: 'deleted', staged: false, unstaged: true },
    ],
    untracked: [
      'notes/new.ts',
      'assets/logo.bin',
      'src/large.txt',
      'src/missing.txt',
      'src/moved.txt',
      'src/long-preview.txt',
      'src/link',
    ],
    unmerged: ['src/conflict.ts', 'src/unmerged-missing.ts'],
  },
};

function readyPreview(
  path: string,
  text: string,
  overrides: Partial<GitFilePreview> = {},
): GitPreviewResponse {
  return {
    state: 'ok',
    preview: {
      path,
      state: 'ready',
      text,
      binary: false,
      size: text.length,
      truncated: false,
      truncated_bytes: 0,
      ...overrides,
    },
  };
}

const FIXTURE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=';
const FIXTURE_WAV_BASE64 = 'UklGRvQHAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YdAHAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
const FIXTURE_PDF_BASE64 = 'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDEyMF0vQ29udGVudHMgNCAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGggNDQ+PnN0cmVhbQpCVCAvRjEgMTIgVGYgMjAgNjAgVGQgKE5lc3Npb24gbWVkaWEgc2FtcGxlKSBUaiBFVAplbmRzdHJlYW0gZW5kb2JqCjUgMCBvYmo8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCnRyYWlsZXI8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgowCiUlRU9GCg==';
const FIXTURE_WEBM_BASE64 = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAK3EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEnTbuMU6uEHFO7a1OsggKh7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAj0AAAAAAABZUrmvMrgEAAAAAAABD14EBc8WIoFP3VVktqNucgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4JSwgRC6gRCagQJVsIhVt4ECVbiBAhJUw2f6c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2MS4xLjEwMHNz1WPAi2PFiKBT91VZLajbZ8igRaOHRU5DT0RFUkSHk0xhdmM2MS4zLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QPXngQCjoYEAAIAQAgCdASoQABAAAEcIhYWIhYSIAgIADA5gAP5oAKOVgQBkALEBAAEQEAAYABhYL/QACAAAo5WBAMgAsQEAARAQABgAGFgv9AAIAACjlYEBLACxAQABEBAAGAAYWC/0AAgAAKOVgQGQALEBAAEQEAAYABhYL/QACAAAo5WBAfQAsQEAARAQABgAGFgv9AAIAACjlYECWACxAQABEBAAGAAYWC/0AAgAAKOVgQK8ALEBAAEQEBRgAGFgv9AAIAAAo5WBAyAAsQEAARAQABgAGFgv9AAIAACjlYEDhACxAQABEBAAGAAYWC/0AAgAABxTu2uRu4+zgQC3iveBAfGCAabwgQM=';

function readyMedia(
  path: string,
  mimeType: string,
  contentBase64: string,
  size: number,
): GitPreviewResponse {
  return {
    state: 'ok',
    preview: {
      path,
      state: 'ready',
      text: '',
      binary: true,
      size,
      truncated: false,
      truncated_bytes: 0,
      media: { content_base64: contentBase64, mime_type: mimeType, complete: true },
    },
  };
}

function mediaFixture(path: string): GitPreviewResponse | null {
  if (path === 'assets/photo.png') {
    return readyMedia(path, 'image/png', FIXTURE_PNG_BASE64, 80);
  }
  if (path === 'assets/sample.webm') {
    return readyMedia(path, 'video/webm', FIXTURE_WEBM_BASE64, 743);
  }
  if (path === 'assets/sample.wav') {
    return readyMedia(path, 'audio/wav', FIXTURE_WAV_BASE64, 2044);
  }
  if (path === 'assets/spec.pdf') {
    return readyMedia(path, 'application/pdf', FIXTURE_PDF_BASE64, 445);
  }
  if (path === 'assets/fake.png') {
    return {
      state: 'ok',
      preview: {
        path,
        state: 'unsupported',
        text: '',
        binary: false,
        size: 14,
        truncated: false,
        truncated_bytes: 0,
        message: "The file's content does not match its extension.",
      },
    };
  }
  if (path === 'assets/oversized.png') {
    return {
      state: 'ok',
      preview: {
        path,
        state: 'too_large',
        text: '',
        binary: false,
        size: 9 * 1024 * 1024,
        truncated: false,
        truncated_bytes: 0,
        message: 'This file is 9437184 bytes, larger than the 8388608-byte media preview limit.',
      },
    };
  }
  return null;
}

function previewStateFor(path: string): GitPreviewResponse | null {
  if (path === 'notes/new.ts') {
    return readyPreview(path, 'export const note = "untracked";\n');
  }
  if (path === 'notes/example.ts') {
    return readyPreview(path, 'export const greeting: string = "hello";\nconsole.log(greeting);\n');
  }
  if (path === 'src/conflict.rs') {
    return readyPreview(path, '<<<<<<< HEAD\nfn mine() {}\n=======\nfn theirs() {}\n>>>>>>> other\n');
  }
  if (path === 'notes/data.json') {
    return readyPreview(path, '{\n  "name": "git-viewer",\n  "nested": { "ok": true },\n  "items": [1, 2, 3]\n}\n');
  }
  if (path === 'notes/events.jsonl') {
    return readyPreview(path, '{"line":1,"ok":true}\n{"line":2,"ok":true}\n');
  }
  if (path === 'notes/README.md') {
    return readyPreview(path, '# Git preview\n\nStructured and source views share one policy.\n');
  }
  if (path === 'notes/broken.json') {
    return readyPreview(path, '{ "broken": true, }\n');
  }
  if (path === 'notes/truncated.json') {
    const text = '{"name":"truncated"';
    return readyPreview(path, text, {
      size: 4103,
      truncated: true,
      truncated_bytes: 4103 - text.length,
    });
  }
  if (path === 'src/conflict.ts') {
    return readyPreview(
      path,
      '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n',
    );
  }
  if (path === 'assets/logo.bin') {
    return readyPreview(path, '', { binary: true, size: 4096 });
  }
  if (path === 'src/large.txt') {
    return readyPreview(path, 'first line\n', {
      size: 4103,
      truncated: true,
      truncated_bytes: 4096,
    });
  }
  if (path === 'src/missing.txt' || path === 'src/unmerged-missing.ts') {
    return { state: 'ok', preview: { path, state: 'missing', text: '', binary: false, size: 0, truncated: false, truncated_bytes: 0 } };
  }
  if (path === 'src/long-preview.txt') {
    const lines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
    return readyPreview(path, lines.join('\n'));
  }
  if (path === 'src/link') {
    return {
      state: 'ok',
      preview: {
        path,
        state: 'unsupported',
        text: '',
        binary: false,
        size: 0,
        truncated: false,
        truncated_bytes: 0,
        message: 'This path is a symbolic link; previews do not follow links.',
      },
    };
  }
  if (path === 'src/moved.txt') {
    return {
      state: 'ok',
      preview: {
        path,
        state: 'changed',
        text: '',
        binary: false,
        size: 0,
        truncated: false,
        truncated_bytes: 0,
        message: 'The file changed while it was being read. Refresh Git Changes.',
      },
    };
  }
  return null;
}

function previewFor(path: string, expected: string, scenario: string, want: 'text' | 'media'): GitPreviewResponse {
  if (want === 'media') {
    const media = mediaFixture(path);
    if (media) {
      return media;
    }
  }
  if (scenario === 'preview-states') {
    const extra = previewStateFor(path);
    if (extra) {
      return extra;
    }
  }
  if (scenario === 'preview-states') {
    if (path === 'notes/new.ts') {
      return readyPreview(path, 'export const note = "untracked";\n');
    }
    if (path === 'src/conflict.ts') {
      return readyPreview(
        path,
        '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n',
      );
    }
    if (path === 'assets/logo.bin') {
      return readyPreview(path, '', { binary: true, size: 4096 });
    }
    if (path === 'src/large.txt') {
      return readyPreview(path, 'first line\n', {
        size: 4103,
        truncated: true,
        truncated_bytes: 4096,
      });
    }
    if (path === 'src/missing.txt' || path === 'src/unmerged-missing.ts') {
      return { state: 'ok', preview: { path, state: 'missing', text: '', binary: false, size: 0, truncated: false, truncated_bytes: 0 } };
    }
    if (path === 'src/long-preview.txt') {
      const lines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
      return readyPreview(path, lines.join('\n'));
    }
    if (path === 'src/link') {
      return {
        state: 'ok',
        preview: {
          path,
          state: 'unsupported',
          text: '',
          binary: false,
          size: 0,
          truncated: false,
          truncated_bytes: 0,
          message: 'This path is a symbolic link; previews do not follow links.',
        },
      };
    }
    if (path === 'src/moved.txt') {
      return {
        state: 'ok',
        preview: {
          path,
          state: 'changed',
          text: '',
          binary: false,
          size: 0,
          truncated: false,
          truncated_bytes: 0,
          message: 'The file changed while it was being read. Refresh Git Changes.',
        },
      };
    }
  }

  if (path.endsWith('index.ts')) {
    return readyPreview(path, "export { GitPlugin } from './GitPlugin';\n");
  }
  if (path === 'notes.md') {
    return readyPreview(path, '# Notes\n\nUntracked work in progress.\n');
  }

  return {
    state: 'ok',
    preview: {
      path,
      state: expected === 'unmerged' ? 'changed' : 'changed',
      text: '',
      binary: false,
      size: 0,
      truncated: false,
      truncated_bytes: 0,
      message: 'This path is no longer in the status group it was selected from. Refresh Git Changes.',
    },
  };
}

function modeDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'old mode 100644',
    'new mode 100755',
  ].join('\n');
}

function longDiff(path: string): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,100 +1,101 @@',
  ];
  for (let index = 1; index <= 100; index += 1) {
    lines.push(` const line${index} = ${index}; // ${'x'.repeat(100)}`);
  }
  lines.push('+const inserted = true;');
  return lines.join('\n');
}

function malformedDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    '-const before = 1;',
    '+const after = 2;',
  ].join('\n');
}

/**
 * Commits, deterministic and offline.
 *
 * Deliberately not all the same shape: one carries refs, one has a subject with
 * punctuation in it, and there are more of them than a screen holds — which is
 * what the list has to have an answer for.
 */
const COMMITS = [
  {
    hash: '4f2a1c9e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    short_hash: '4f2a1c9',
    author: 'Nathan',
    relative_date: '2 hours ago',
    date: '2026-09-19T14:20:00+08:00',
    subject: 'feat(capability): let a capability emerge beside the capsule (#826)',
    refs: 'HEAD -> feat/repo-status',
  },
  {
    hash: '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c',
    short_hash: '9b8c7d6',
    author: 'Nathan',
    relative_date: '1 day ago',
    date: '2026-09-18T09:05:00+08:00',
    subject: 'fix(git): stack the view when the pane is narrow, and stop repeating the heading',
    refs: '',
  },
  {
    hash: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    short_hash: '1a2b3c4',
    author: 'Ada',
    relative_date: '3 days ago',
    date: '2026-09-16T18:44:00+08:00',
    subject: 'docs: a subject with | punctuation — and a dash (so the parser is honest)',
    refs: 'tag: v0.35.0',
  },
];

/**
 * What each commit touched, by short hash.
 *
 * Separate from `COMMITS` rather than a field on it: the log this fixture serves
 * is `git log` without `--name-status`, so a commit row has no files and putting
 * them there would put a field on the wire the agent does not send. The detail
 * asks a second question (`git.commit`) and this is that question's answer.
 */
const COMMIT_FILES: Record<string, { path: string; status: string }[]> = {
  '4f2a1c9': [
    { path: 'web/src/product/terminal/capsule/PeekHost.tsx', status: 'A' },
    { path: 'web/src/app/capsuleProjections.ts', status: 'M' },
    { path: 'docs/design/capability-emergence.md', status: 'M' },
  ],
  '9b8c7d6': [{ path: 'web/src/capabilities/git/components/GitHistoryView.tsx', status: 'M' }],
  '1a2b3c4': [{ path: 'docs/design/design-system/patterns/terminal-capsule.md', status: 'M' }],
};

/**
 * The commit behind a History row, when the view opens one.
 *
 * **Derived from the same `COMMITS` the log is.** The row and the detail are one
 * commit, and a second literal would be a second answer to what it says — which
 * nothing would catch, because both views would render their own copy
 * confidently. This is the fixture's whole rule applied to a second question
 * about the same object.
 *
 * The message is **not** truncated: `Message truncated — N not read` is a state
 * the view has to have, and a fixture that always produced it would make every
 * picture of this panel a picture of that state. No route asks for the truncated
 * one yet, so this answers the state every repository is in.
 */
function commitDetailFor(oid: string): GitCommitResponse {
  const commit = COMMITS.find((c) => c.hash === oid || c.short_hash === oid);
  if (!commit) {
    // The agent validates the object name and answers an error for one it cannot
    // resolve. A fixture that invented a commit for an unknown revision would let
    // the view render a state the product cannot produce for that request.
    return { state: 'error', message: `unknown revision: ${oid}` };
  }
  return {
    state: 'ok',
    commit: {
      oid: commit.hash,
      short_oid: commit.short_hash,
      // The oldest commit in the fixture is the root, so it has no parent; the
      // others chain onto the one below them in `COMMITS`.
      parents: COMMITS[COMMITS.indexOf(commit) + 1] ? [COMMITS[COMMITS.indexOf(commit) + 1].hash] : [],
      author: commit.author,
      author_date: commit.date,
      committer: commit.author,
      commit_date: commit.date,
      subject: commit.subject,
      body: '',
      decorations: commit.refs,
      files: (COMMIT_FILES[commit.short_hash] ?? []).map((f) => ({ ...f, binary: false })),
      files_truncated: false,
      files_truncated_bytes: 0,
      message_truncated: false,
      message_truncated_bytes: 0,
      merge_diff_parent: '',
    },
  };
}

/**
 * What the agent uses when the caller asks for no particular count — the
 * `DEFAULT_LOG_LIMIT` in `crates/nession-git/src/security.rs`.
 *
 * Modelled rather than echoed back as the commit count, because the view's
 * "showing the most recent N" rule reads the count the *answer* reports. A
 * fixture that answered `limit: 3` would have that rule announce older commits
 * in a repository that has exactly three, which is a state the real agent
 * cannot produce for this request.
 */
const DEFAULT_HISTORY_LIMIT = 50;

function historyFor(limit: unknown): GitLogResponse {
  const asked =
    typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DEFAULT_HISTORY_LIMIT;
  const commits = COMMITS.slice(0, Math.min(asked, COMMITS.length));
  return {
    state: 'ok',
    history: {
      commits,
      limit: asked,
      truncated_bytes: 0,
      truncated: false,
      end_of_history: commits.length < asked,
      next_cursor:
        commits.length >= asked ? commits[commits.length - 1]?.hash : undefined,
    },
  };
}

/**
 * The agent's default when the caller asks for no particular count —
 * `DEFAULT_BRANCH_LIMIT` in `crates/nession-git/src/security.rs`.
 */
const DEFAULT_BRANCH_LIMIT = 100;

/**
 * Branches, one of each state the view has to have an answer for: the current
 * one carrying unpushed work, one in sync, one with no upstream at all, and one
 * whose upstream was deleted — the case that arrives as identical counts to "in
 * sync" and is separated only by `upstream` being present.
 *
 * The current branch is first, which is the order the agent's `--sort=-HEAD`
 * produces and the reason its `--count` can never cut the current branch off.
 */
const BRANCHES = [
  {
    name: 'feat/repo-status',
    current: true,
    upstream: 'origin/feat/repo-status',
    ahead: 2,
    behind: 1,
    upstream_gone: false,
  },
  {
    name: 'main',
    current: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    upstream_gone: false,
  },
  {
    name: 'local-only',
    current: false,
    ahead: 0,
    behind: 0,
    upstream_gone: false,
  },
  {
    name: 'chore/old-remote',
    current: false,
    upstream: 'origin/chore/old-remote',
    ahead: 0,
    behind: 0,
    upstream_gone: true,
  },
];

function branchesFor(limit: unknown): GitBranchesResponse {
  const asked =
    typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DEFAULT_BRANCH_LIMIT;
  const branches = BRANCHES.slice(0, Math.min(asked, BRANCHES.length));
  return {
    state: 'ok',
    branches: { branches, limit: asked, truncated_bytes: 0, truncated: false },
  };
}

/**
 * Worktrees: this checkout, a linked one on another branch, and one whose
 * directory has been deleted — a state `git worktree list` keeps reporting
 * until something prunes it, and one a row must not present as a place to go.
 */
const WORKTREES: GitWorktreesResponse = {
  state: 'ok',
  worktrees: {
    worktrees: [
      {
        path: FIXTURE_ROOT,
        branch: 'feat/repo-status',
        current: true,
        detached: false,
        bare: false,
      },
      {
        path: '/Users/dev/code/nession-capsule.wt/docs',
        branch: 'docs/record-closure',
        current: false,
        detached: false,
        bare: false,
      },
      {
        path: '/Users/dev/code/nession-capsule.gone',
        branch: 'chore/old-remote',
        current: false,
        detached: false,
        bare: false,
        prunable: 'gitdir file points to non-existent location',
      },
    ],
    truncated_bytes: 0,
    truncated: false,
  },
};

/**
 * The deterministic long ref inventory behind `git=long-lists` (#4188).
 *
 * The canonical three-row answers cannot overflow the App bounded section at a
 * phone width, so the nested Branches/Worktrees Cases had no fixture that could
 * exercise their end-of-scroll geometry. These rows are ordinary shapes the
 * agent really reports — current, tracking, detached, locked, bare, prunable —
 * just enough of them to require scrolling.
 */
const LONG_REF_COUNT = 40;

function longBranchesFor(limit: unknown): GitBranchesResponse {
  const all = Array.from({ length: LONG_REF_COUNT }, (_, index) => {
    const name = index === 0 ? 'feat/long-list' : `feat/list-${String(index).padStart(2, '0')}`;
    return {
      name,
      current: index === 0,
      upstream: `origin/${name}`,
      ahead: index % 3 === 0 ? index : 0,
      behind: index % 4 === 0 ? 1 : 0,
      upstream_gone: false,
    };
  });
  // Like the agent, honor the caller's limit and report what was asked.
  const asked =
    typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DEFAULT_BRANCH_LIMIT;
  const branches = all.slice(0, Math.min(asked, all.length));
  return {
    state: 'ok',
    branches: {
      branches,
      limit: asked,
      truncated_bytes: 0,
      truncated: false,
    },
  };
}

const LONG_WORKTREES: GitWorktreesResponse = {
  state: 'ok',
  worktrees: {
    worktrees: Array.from({ length: LONG_REF_COUNT }, (_, index) => {
      const path = index === 0 ? FIXTURE_ROOT : `/Users/dev/code/nession-long.wt/${index}`;
      if (index > 0 && index % 7 === 0) {
        return {
          path,
          branch: undefined,
          current: false,
          detached: true,
          bare: false,
          locked: index % 14 === 0 ? 'on a removable drive' : '',
        };
      }
      if (index > 0 && index % 11 === 0) {
        return {
          path,
          branch: undefined,
          current: false,
          detached: false,
          bare: true,
        };
      }
      if (index > 0 && index % 13 === 0) {
        return {
          path,
          branch: `chore/gone-${index}`,
          current: false,
          detached: false,
          bare: false,
          prunable: 'gitdir file points to non-existent location',
        };
      }
      return {
        path,
        branch: index === 0 ? 'feat/long-list' : `feat/list-${String(index).padStart(2, '0')}`,
        current: index === 0,
        detached: false,
        bare: false,
      };
    }),
    truncated_bytes: 0,
    truncated: false,
  },
};

function okDiff(
  path: string,
  diff: GitFileDiff,
  snapshot: GitSnapshot,
): GitDiffResponse {
  return { state: 'ok', diff: { ...diff, path }, snapshot };
}

function diffFor(path: string, scenario: string, snapshot: GitSnapshot): GitDiffResponse {
  if (path.endsWith('.png')) {
    return okDiff(
      path,
      { path, text: '', binary: true, truncated_bytes: 0, truncated: false },
      snapshot,
    );
  }

  if (scenario === 'preview-states' && path === 'src/deleted.ts') {
    return {
      state: 'error',
      message: 'This file is no longer available in the worktree.',
    };
  }

  if (scenario === 'diff-states') {
    if (path === 'mode/run.sh') {
      return okDiff(
        path,
        { path, text: modeDiff(path), binary: false, truncated_bytes: 0, truncated: false },
        snapshot,
      );
    }
    if (path === 'src/empty.txt') {
      return okDiff(
        path,
        { path, text: '', binary: false, truncated_bytes: 0, truncated: false },
        snapshot,
      );
    }
    if (path === 'src/large.ts') {
      return okDiff(
        path,
        {
          path,
          text: changedDiff(path),
          binary: false,
          truncated_bytes: 4096,
          truncated: true,
        },
        snapshot,
      );
    }
    if (path === 'src/long.ts') {
      return okDiff(
        path,
        { path, text: longDiff(path), binary: false, truncated_bytes: 0, truncated: false },
        snapshot,
      );
    }
    if (path === 'src/malformed.ts') {
      return okDiff(
        path,
        {
          path,
          text: malformedDiff(path),
          binary: false,
          truncated_bytes: 0,
          truncated: false,
        },
        snapshot,
      );
    }
    return okDiff(
      path,
      { path, text: changedDiff(path), binary: false, truncated_bytes: 0, truncated: false },
      snapshot,
    );
  }

  return okDiff(
    path,
    { path, text: changedDiff(path), binary: false, truncated_bytes: 0, truncated: false },
    snapshot,
  );
}
