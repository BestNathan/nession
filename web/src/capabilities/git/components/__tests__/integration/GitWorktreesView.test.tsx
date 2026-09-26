import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWorktreesView } from '../../GitWorktreesView';
import { gitApi } from '../../../GitPlugin';
import type { GitWorktree, GitWorktreesResponse } from '../../../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import type { Agent, Session } from '@/types';

vi.mock('../../../GitPlugin', () => ({
  gitApi: {
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    gitRoot: vi.fn(),
    gitLog: vi.fn(),
    gitBranches: vi.fn(),
    gitWorktrees: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
  },
}));

const mockedWorktrees = vi.mocked(gitApi.gitWorktrees);

const agent = { agent_id: 'a1', hostname: 'devbox' } as Agent;
const session = { session_id: 'a1:work', agent_id: 'a1', session_name: 'work' } as Session;

function ctx(): WorkspaceContext {
  return {
    session,
    agent,
    agents: [agent],
    domain: null,
    fileOps: null,
    experience: 'web',
    onToolChange: () => {},
  };
}

function worktree(overrides: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path: '/repo',
    branch: 'main',
    current: false,
    detached: false,
    bare: false,
    ...overrides,
  };
}

function ok(
  worktrees: GitWorktree[],
  extra: Partial<GitWorktreesResponse & { state: 'ok' }> = {},
) {
  return {
    state: 'ok',
    worktrees: { worktrees, truncatedBytes: 0, truncated: false },
    ...extra,
  } as GitWorktreesResponse;
}

describe('GitWorktreesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedWorktrees.mockResolvedValue(ok([worktree()]));
  });

  it('asks the agent for worktrees, naming the agent to route to', async () => {
    render(<GitWorktreesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-worktree-list')).toBeInTheDocument();
    expect(mockedWorktrees).toHaveBeenCalledWith({ agent_id: 'a1', session: 'a1:work' });
  });

  it('leads with the name a person calls the checkout, and keeps the address', async () => {
    // `worktree list` prints absolute paths, two of which commonly end in the
    // same directory name. The basename is what identifies it; the full path
    // stays one hover away rather than gone.
    mockedWorktrees.mockResolvedValue(
      ok([worktree({ path: '/Users/dev/code/project/.claude/worktrees/capsule' })]),
    );

    render(<GitWorktreesView ctx={ctx()} />);

    const row = (await screen.findAllByTestId('git-worktree-row'))[0];
    expect(row).toHaveTextContent('capsule');
    expect(row).toHaveAttribute('title', '/Users/dev/code/project/.claude/worktrees/capsule');
    expect(row).toHaveAttribute('data-path', '/Users/dev/code/project/.claude/worktrees/capsule');
  });

  it('marks the checkout the Session is in, and marks only it', async () => {
    mockedWorktrees.mockResolvedValue(
      ok([
        worktree({ path: '/repo', current: true, branch: 'feat/x' }),
        worktree({ path: '/repo.wt/other', branch: 'main' }),
      ]),
    );

    render(<GitWorktreesView ctx={ctx()} />);

    const rows = await screen.findAllByTestId('git-worktree-row');
    expect(rows.map((row) => row.getAttribute('data-current'))).toEqual(['true', null]);
    expect(rows[0]).toHaveTextContent('*');
    expect(rows[1]).not.toHaveTextContent('*');
  });

  it('names a detached and a bare checkout rather than leaving them blank', async () => {
    // Neither carries a `branch`, so a row that rendered the branch alone would
    // be an empty line under a directory name.
    mockedWorktrees.mockResolvedValue(
      ok([
        worktree({ path: '/repo/detached', detached: true, branch: undefined }),
        worktree({ path: '/repo/bare.git', bare: true, branch: undefined }),
      ]),
    );

    render(<GitWorktreesView ctx={ctx()} />);

    const rows = await screen.findAllByTestId('git-worktree-row');
    expect(rows[0]).toHaveTextContent('Detached HEAD');
    expect(rows[1]).toHaveTextContent('Bare repository');
  });

  it('says a prunable entry is gone rather than presenting it as a place to go', async () => {
    // git keeps the administrative entry after the directory is deleted, so a
    // row that rendered as an ordinary checkout would name somewhere that does
    // not exist — the same "pretend it is clean" failure the status view
    // refuses to make about a conflicted tree.
    mockedWorktrees.mockResolvedValue(
      ok([worktree({ path: '/repo/gone', prunable: 'gitdir file points nowhere' })]),
    );

    render(<GitWorktreesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-worktree-prunable')).toHaveTextContent(
      'directory is gone',
    );
  });

  it('reports a lock, with its reason when there is one', async () => {
    mockedWorktrees.mockResolvedValue(
      ok([
        worktree({ path: '/repo/locked', locked: 'on a removable drive' }),
        worktree({ path: '/repo/locked-bare', locked: '' }),
      ]),
    );

    render(<GitWorktreesView ctx={ctx()} />);

    const locks = await screen.findAllByTestId('git-worktree-locked');
    expect(locks[0]).toHaveTextContent('Locked — on a removable drive');
    // An empty reason is still locked; rendering it as unlocked would report a
    // protected worktree as movable.
    expect(locks[1]).toHaveTextContent('Locked');
    expect(locks[1]).not.toHaveTextContent('—');
  });

  it('reports truncation rather than a listing that quietly stops', async () => {
    mockedWorktrees.mockResolvedValue(
      ok([worktree()], {
        worktrees: { worktrees: [worktree()], truncatedBytes: 2048, truncated: true },
      }),
    );

    render(<GitWorktreesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-worktrees-truncated')).toHaveTextContent('2.0 KB');
  });

  it('does not render an empty frame for an answer git cannot give', async () => {
    // `git worktree list` always reports at least the repository itself, so an
    // empty answer is not a state the agent produces — and an empty list would
    // read as "still loading".
    mockedWorktrees.mockResolvedValue(ok([]));

    render(<GitWorktreesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-worktrees-none')).toBeInTheDocument();
  });

  it('reports the agent’s failure states with their own copy', async () => {
    mockedWorktrees.mockResolvedValue({ state: 'not_a_repository', message: 'not a git repository' });

    render(<GitWorktreesView ctx={ctx()} />);

    const panel = await screen.findByTestId('git-worktrees-unavailable');
    expect(panel).toHaveAttribute('data-state', 'not_a_repository');
    expect(panel).toHaveTextContent(/not in a git repository/i);
  });

  it('surfaces a transport failure instead of an empty list', async () => {
    mockedWorktrees.mockRejectedValue(new Error('connection closed'));

    render(<GitWorktreesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-worktrees-error')).toHaveTextContent(
      'connection closed',
    );
  });
});
