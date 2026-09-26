import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitProjection } from '../../GitProjection';
import { gitApi } from '../../../GitPlugin';
import type { GitStatusResponse } from '../../../types';

vi.mock('../../../GitPlugin', () => ({
  gitApi: {
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    gitRoot: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
  },
}));

const mockedStatus = vi.mocked(gitApi.gitStatus);

const ROOT = '/Users/dev/code/nession-capsule';

function status(overrides: Partial<GitStatusResponse & { state: 'ok' }> = {}): GitStatusResponse {
  return {
    state: 'ok',
    root: ROOT,
    truncated: false,
    truncatedBytes: 0,
    status: {
      branch: 'feat/capsule',
      detached: false,
      ahead: 2,
      behind: 0,
      modified: [
        { path: 'web/src/a/TerminalCapsule.tsx', kind: 'modified', staged: true, unstaged: false },
        { path: 'web/src/b/useCapsuleState.ts', kind: 'modified', staged: false, unstaged: true },
      ],
      untracked: ['web/src/c/GitProjection.tsx'],
      unmerged: [],
    },
    ...overrides,
  } as GitStatusResponse;
}

function renderProjection(depth: 'signal' | 'peek', onFocusChange = vi.fn()) {
  render(
    <GitProjection
      agentId="a1"
      sessionId="a1:work"
      depth={depth}
      onFocusChange={onFocusChange}
    />,
  );
  return { onFocusChange };
}

describe('Git Signal (L1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStatus.mockResolvedValue(status());
  });

  it('names the branch, the work tree, and how far it has drifted', async () => {
    renderProjection('signal');

    // `capability-emergence.md` names exactly these: branch, worktree identity,
    // change count, ahead/behind.
    const body = await screen.findByTestId('git-signal-body');
    expect(body).toHaveTextContent('feat/capsule');
    expect(body).toHaveTextContent('worktree: nession-capsule');
    expect(body).toHaveTextContent('2 ahead');
  });

  it('is not a toolbar — it states the current state and nothing else', async () => {
    renderProjection('signal');
    await screen.findByTestId('git-signal-body');

    // A Signal is "the smallest identifying state needed". Anything pressable
    // would make it a surface the user has to read as a set of actions.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByTestId('git-peek-body')).toBeNull();
  });

  it('says so plainly when the tree is clean', async () => {
    mockedStatus.mockResolvedValue(
      status({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [],
          untracked: [],
          unmerged: [],
        },
      }),
    );

    renderProjection('signal');

    expect(await screen.findByTestId('git-signal-body')).toHaveTextContent('Working tree clean');
  });

  it('takes no space when it has nothing to say', async () => {
    // A Signal that cannot say anything is not worth the room it takes from the
    // work surface. The readable copy for each failure lives in the Workspace,
    // which is where someone can act on it.
    mockedStatus.mockResolvedValue({ state: 'not_a_repository', message: 'not a git repository' });

    renderProjection('signal');

    const body = await screen.findByText(/not in a git repository/i);
    expect(body).toBeInTheDocument();
    expect(screen.queryByTestId('git-signal-body')).toBeNull();
  });
});

describe('Git Peek (L2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStatus.mockResolvedValue(status());
  });

  it('splits staged from unstaged', async () => {
    renderProjection('peek');

    expect(await screen.findByTestId('git-peek-body')).toHaveTextContent('1 staged · 1 unstaged');
  });

  it('summarises changed files by name, not by full path', async () => {
    renderProjection('peek');

    const rows = await screen.findAllByTestId('git-peek-file');
    expect(rows.map((row) => row.textContent)).toEqual([
      'MTerminalCapsule.tsx',
      'MuseCapsuleState.ts',
      '?GitProjection.tsx',
    ]);
    // The full path stays reachable for anyone who needs to disambiguate.
    expect(rows[0]).toHaveAttribute('title', 'web/src/a/TerminalCapsule.tsx');
  });

  it('stops before the full listing, and says how much it left', async () => {
    // "It should not render a full diff, commit graph, branch manager, or
    // history browser." Counting the remainder is more honest than silently
    // showing the first few.
    mockedStatus.mockResolvedValue(
      status({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: Array.from({ length: 7 }, (_, i) => ({
            path: `src/file-${i}.ts`,
            kind: 'modified' as const,
            staged: false,
            unstaged: true,
          })),
          untracked: [],
          unmerged: [],
        },
      }),
    );

    renderProjection('peek');

    expect(await screen.findAllByTestId('git-peek-file')).toHaveLength(4);
    expect(screen.getByTestId('git-peek-more')).toHaveTextContent('and 3 more');
  });

  it('reports what the user picked, so the handoff can carry it', async () => {
    const { onFocusChange } = renderProjection('peek');

    await userEvent.click((await screen.findAllByTestId('git-peek-file'))[1]);

    expect(onFocusChange).toHaveBeenCalledWith('web/src/b/useCapsuleState.ts');
  });

  it('never shows a diff', async () => {
    renderProjection('peek');
    await screen.findByTestId('git-peek-body');

    expect(screen.queryByTestId('git-diff-body')).toBeNull();
    expect(screen.queryByTestId('git-diff')).toBeNull();
  });
});
