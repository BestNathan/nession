import type { PluginSurface } from '@/platform/socket/types';
import type { GitDiffResponse, GitStatusResponse } from '@/capabilities/git';

/**
 * A canned git backend for the fixture route.
 *
 * The fixture is offline, so the git capability has nothing to talk to. This
 * stands in for the agent's `extension.git.*` answers with deterministic data,
 * which is what lets the canonical route render the view at all — and therefore
 * what lets e2e assert #750 SC2 (untracked has no expander) and SC5 (no write
 * affordance) against real DOM rather than against a jsdom mock.
 *
 * What it varies is the *repository*, never the component's state: a route
 * cannot ask for "the truncated view" or "the failure view" directly, only for
 * a repository that produces one. A fixture that could name a state would let a
 * test assert a rendering the app never decided on.
 *
 *   /#/fixture/workspace?capability=git              → a repository with changes
 *   /#/fixture/workspace?capability=git&git=clean    → a clean working tree
 */
export function fixtureGitSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('git') ?? 'changed';
  const status = scenario === 'clean' ? CLEAN_STATUS : CHANGED_STATUS;

  return {
    connectionState: 'connected',
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      if (type === 'extension.git.status') {
        return Promise.resolve(status as T);
      }
      if (type === 'extension.git.diff') {
        return Promise.resolve(diffFor(String(payload.path)) as T);
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

function diffFor(path: string): GitDiffResponse {
  if (path.endsWith('.png')) {
    return {
      state: 'ok',
      diff: { path, text: '', binary: true, truncatedBytes: 0, truncated: false },
    };
  }
  return {
    state: 'ok',
    diff: { path, text: TEXT_DIFF, binary: false, truncatedBytes: 0, truncated: false },
  };
}
