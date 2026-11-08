import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import type {
  GitBranchesResponse,
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
  if (String(payload.expectedSnapshot ?? '') !== repo.snapshot.token) {
    return {
      state: 'repository_changed',
      message: 'The repository changed after it was reviewed.',
      snapshot: repo.snapshot,
      status: repo.status.status,
      truncated: false,
      truncatedBytes: 0,
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
      root: FIXTURE_ROOT,
      snapshot: repo.snapshot,
      truncated: false,
      truncatedBytes: 0,
    };
    return {
      state: 'ok' as const,
      snapshot: repo.snapshot,
      status: next,
      truncated: false,
      truncatedBytes: 0,
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
 *   /#/fixture/workspace?capability=git&git=diff-states → one file of each diff
 *     state the renderer owns: ordinary, binary, mode-only, empty, truncated,
 *     malformed/raw-fallback, and one longer than the pane
 *   /#/fixture/workspace?capability=git&git=preview-states → untracked,
 *     conflicted, binary, truncated, missing and changed previews
 *   /#/fixture/workspace?capability=git&git=overlap  → the first status read is
 *     held until the Case releases it, so a manual Refresh can answer first
 *     with the newer repository state (#2787)
 */
export function fixtureGitSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('git') ?? 'changed';
  const status =
    scenario === 'clean'
      ? CLEAN_STATUS
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
          previewFor(String(payload.path), String(payload.expected), scenario) as T,
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

/** The work tree the fixture pretends to be in — a Peek names its basename. */
const FIXTURE_ROOT = '/Users/dev/code/nession-capsule';

/** A snapshot identity for a canned state; only equality is meaningful. */
function fixtureSnapshot(token: string, head: string | null): GitSnapshot {
  return { token, head, root: FIXTURE_ROOT };
}

const CLEAN_STATUS: GitStatusResponse = {
  state: 'ok',
  root: FIXTURE_ROOT,
  snapshot: fixtureSnapshot('fixture-clean-0', 'fixture-head-clean'),
  truncated: false,
  truncatedBytes: 0,
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
  truncatedBytes: 0,
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
  truncatedBytes: 0,
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
  truncatedBytes: 0,
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

function previewFor(path: string, expected: string, scenario: string): GitPreviewResponse {
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
    shortHash: '4f2a1c9',
    author: 'Nathan',
    relativeDate: '2 hours ago',
    date: '2026-09-19T14:20:00+08:00',
    subject: 'feat(capability): let a capability emerge beside the capsule (#826)',
    refs: 'HEAD -> feat/repo-status',
  },
  {
    hash: '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c',
    shortHash: '9b8c7d6',
    author: 'Nathan',
    relativeDate: '1 day ago',
    date: '2026-09-18T09:05:00+08:00',
    subject: 'fix(git): stack the view when the pane is narrow, and stop repeating the heading',
    refs: '',
  },
  {
    hash: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    shortHash: '1a2b3c4',
    author: 'Ada',
    relativeDate: '3 days ago',
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
  const commit = COMMITS.find((c) => c.hash === oid || c.shortHash === oid);
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
      shortOid: commit.shortHash,
      // The oldest commit in the fixture is the root, so it has no parent; the
      // others chain onto the one below them in `COMMITS`.
      parents: COMMITS[COMMITS.indexOf(commit) + 1] ? [COMMITS[COMMITS.indexOf(commit) + 1].hash] : [],
      author: commit.author,
      authorDate: commit.date,
      committer: commit.author,
      commitDate: commit.date,
      subject: commit.subject,
      body: '',
      decorations: commit.refs,
      files: (COMMIT_FILES[commit.shortHash] ?? []).map((f) => ({ ...f, binary: false })),
      filesTruncated: false,
      filesTruncatedBytes: 0,
      messageTruncated: false,
      messageTruncatedBytes: 0,
      mergeDiffParent: '',
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
      truncatedBytes: 0,
      truncated: false,
      endOfHistory: commits.length < asked,
      nextCursor:
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
    upstreamGone: false,
  },
  {
    name: 'main',
    current: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    upstreamGone: false,
  },
  {
    name: 'local-only',
    current: false,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
  },
  {
    name: 'chore/old-remote',
    current: false,
    upstream: 'origin/chore/old-remote',
    ahead: 0,
    behind: 0,
    upstreamGone: true,
  },
];

function branchesFor(limit: unknown): GitBranchesResponse {
  const asked =
    typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DEFAULT_BRANCH_LIMIT;
  const branches = BRANCHES.slice(0, Math.min(asked, BRANCHES.length));
  return {
    state: 'ok',
    branches: { branches, limit: asked, truncatedBytes: 0, truncated: false },
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
    truncatedBytes: 0,
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
