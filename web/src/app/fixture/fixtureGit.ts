import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import type {
  GitBranchesResponse,
  GitDiffResponse,
  GitLogResponse,
  GitStatusResponse,
  GitWorktreesResponse,
} from '@/capabilities/git';
import { FIXTURE_AGENTS } from './fixtureData';

/**
 * A canned git backend for the fixture route.
 *
 * The fixture is offline, so the git capability has nothing to talk to. This
 * stands in for the agent's `git.*` answers with deterministic data,
 * which is what lets the canonical route render the view at all — and therefore
 * what lets e2e assert #750 SC2 (untracked has no expander) and SC5 (no write
 * affordance) against real DOM rather than against a jsdom mock.
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
 */
export function fixtureGitSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('git') ?? 'changed';
  const status = scenario === 'clean' ? CLEAN_STATUS : CHANGED_STATUS;

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
        return Promise.resolve(status as T);
      }
      if (type === 'git.diff') {
        return Promise.resolve(diffFor(String(payload.path)) as T);
      }
      if (type === 'git.log') {
        return Promise.resolve(historyFor(payload.limit) as T);
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

/** The work tree the fixture pretends to be in — a Signal names its basename. */
const FIXTURE_ROOT = '/Users/dev/code/nession-capsule';

const CLEAN_STATUS: GitStatusResponse = {
  state: 'ok',
  root: FIXTURE_ROOT,
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
        path: 'crates/nession-git/src/cmd.rs',
        kind: 'modified',
        staged: true,
        unstaged: false,
      },
      {
        path: 'web/src/capabilities/git/GitPlugin.ts',
        kind: 'modified',
        staged: false,
        unstaged: true,
      },
      { path: 'assets/logo.png', kind: 'modified', staged: false, unstaged: true },
    ],
    untracked: ['web/src/capabilities/git/index.ts', 'notes.md'],
    unmerged: [],
  },
};

const TEXT_DIFF = [
  'diff --git a/web/src/capabilities/git/GitPlugin.ts b/web/src/capabilities/git/GitPlugin.ts',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/web/src/capabilities/git/GitPlugin.ts',
  '+++ b/web/src/capabilities/git/GitPlugin.ts',
  '@@ -1,4 +1,5 @@',
  " import type { TransportPlugin } from '@/platform/socket/types';",
  "+import type { GitStatusRequest } from './types';",
  ' ',
  ' export class GitPlugin implements TransportPlugin {',
  '-  readonly name = "claude-code";',
  '+  readonly name = "git";',
].join('\n');

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
    history: { commits, limit: asked, truncatedBytes: 0, truncated: false },
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

function diffFor(path: string): GitDiffResponse {
  if (path.endsWith('.png')) {
    return {
      state: 'ok',
      diff: { path, text: '', binary: true, truncated_bytes: 0, truncated: false },
    };
  }
  return {
    state: 'ok',
    diff: { path, text: TEXT_DIFF, binary: false, truncated_bytes: 0, truncated: false },
  };
}
