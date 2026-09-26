import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitBranchesView } from '../../GitBranchesView';
import { gitApi } from '../../../GitPlugin';
import type { GitBranch, GitBranchesResponse } from '../../../types';
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

const mockedBranches = vi.mocked(gitApi.gitBranches);

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

function branch(overrides: Partial<GitBranch> = {}): GitBranch {
  return {
    name: 'main',
    current: false,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    ...overrides,
  };
}

function ok(
  branches: GitBranch[],
  extra: Partial<GitBranchesResponse & { state: 'ok' }> = {},
) {
  return {
    state: 'ok',
    branches: { branches, limit: branches.length, truncatedBytes: 0, truncated: false },
    ...extra,
  } as GitBranchesResponse;
}

describe('GitBranchesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBranches.mockResolvedValue(ok([branch()]));
  });

  it('asks the agent for branches, naming the agent to route to', async () => {
    render(<GitBranchesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-branch-list')).toBeInTheDocument();
    expect(mockedBranches).toHaveBeenCalledWith({ agent_id: 'a1', session: 'a1:work' });
  });

  it('marks the current branch, and marks only it', async () => {
    mockedBranches.mockResolvedValue(
      ok([
        branch({ name: 'feat/x', current: true, upstream: 'origin/feat/x', ahead: 2 }),
        branch({ name: 'main', upstream: 'origin/main' }),
      ]),
    );

    render(<GitBranchesView ctx={ctx()} />);

    const rows = await screen.findAllByTestId('git-branch-row');
    expect(rows.map((row) => row.getAttribute('data-current'))).toEqual(['true', null]);
    expect(rows[0]).toHaveTextContent('*');
    expect(rows[1]).not.toHaveTextContent('*');
  });

  it('separates "in sync" from "no upstream", which arrive identically', async () => {
    // The whole reason `upstream` is on the wire beside the counts: the agent
    // reports `ahead: 0, behind: 0` for both, and they are different sentences.
    // A view that rendered the counts alone would say nothing at all for either.
    mockedBranches.mockResolvedValue(
      ok([
        branch({ name: 'tracked', upstream: 'origin/tracked' }),
        branch({ name: 'untracked' }),
      ]),
    );

    render(<GitBranchesView ctx={ctx()} />);

    const rows = await screen.findAllByTestId('git-branch-row');
    expect(rows[0]).toHaveTextContent('origin/tracked');
    expect(rows[0]).not.toHaveTextContent('No upstream');

    expect(rows[1]).toHaveTextContent('No upstream');
    expect(rows[1].querySelector('[data-testid="git-branch-tracking"]')).toBeNull();
  });

  it('says how far a branch is from its upstream, and stays quiet when it is level', async () => {
    mockedBranches.mockResolvedValue(
      ok([
        branch({ name: 'diverged', upstream: 'origin/diverged', ahead: 2, behind: 1 }),
        branch({ name: 'behind', upstream: 'origin/behind', behind: 3 }),
        branch({ name: 'level', upstream: 'origin/level' }),
      ]),
    );

    render(<GitBranchesView ctx={ctx()} />);

    const rows = await screen.findAllByTestId('git-branch-row');
    expect(rows[0]).toHaveTextContent('origin/diverged · 2 ahead · 1 behind');
    expect(rows[1]).toHaveTextContent('origin/behind · 3 behind');
    // `visual-language.md` P6: level is a healthy state, not an achievement —
    // it says what is true (the upstream) and stops.
    expect(rows[2]).toHaveTextContent('origin/level');
    expect(rows[2]).not.toHaveTextContent('ahead');
    expect(rows[2]).not.toHaveTextContent('behind');
  });

  it('names a deleted upstream instead of reporting it as level', async () => {
    // `[gone]` arrives with zero counts too. Reporting that as "in sync" would
    // tell the user their branch is pushed when the ref it tracked is gone.
    mockedBranches.mockResolvedValue(
      ok([branch({ name: 'old', upstream: 'origin/old', upstreamGone: true })]),
    );

    render(<GitBranchesView ctx={ctx()} />);

    const row = (await screen.findAllByTestId('git-branch-row'))[0];
    expect(row).toHaveTextContent('origin/old · upstream deleted');
    expect(row).not.toHaveTextContent('ahead');
  });

  it('says when the answer is only part of the repository', async () => {
    const branches = [branch({ name: 'b'.repeat(3) }), branch({ name: 'a'.repeat(3) })];
    mockedBranches.mockResolvedValue(
      ok(branches, {
        branches: { branches, limit: 2, truncatedBytes: 0, truncated: false },
      }),
    );

    render(<GitBranchesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-branches-more')).toHaveTextContent('Showing 2');
  });

  it('does not claim there are more when the answer is short of the limit', async () => {
    // A short answer is a complete one. Offering "the rest are not loaded" over
    // a repository whose whole branch list is on screen is a lie to act on.
    mockedBranches.mockResolvedValue(
      ok([branch()], {
        branches: { branches: [branch()], limit: 100, truncatedBytes: 0, truncated: false },
      }),
    );

    render(<GitBranchesView ctx={ctx()} />);

    await screen.findByTestId('git-branch-list');
    expect(screen.queryByTestId('git-branches-more')).toBeNull();
  });

  it('reports truncation rather than a listing that quietly stops', async () => {
    mockedBranches.mockResolvedValue(
      ok([branch()], {
        branches: { branches: [branch()], limit: 1, truncatedBytes: 4096, truncated: true },
      }),
    );

    render(<GitBranchesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-branches-truncated')).toHaveTextContent('4.0 KB');
  });

  it('tells a repository with no branches apart from a failure', async () => {
    // `git init` and nothing else is a real state, not an error.
    mockedBranches.mockResolvedValue(ok([]));

    render(<GitBranchesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-branches-none')).toHaveTextContent(
      'no branches yet',
    );
  });

  it('reports the agent’s failure states with their own copy', async () => {
    mockedBranches.mockResolvedValue({ state: 'not_a_repository', message: 'not a git repository' });

    render(<GitBranchesView ctx={ctx()} />);

    const panel = await screen.findByTestId('git-branches-unavailable');
    expect(panel).toHaveAttribute('data-state', 'not_a_repository');
    expect(panel).toHaveTextContent(/not in a git repository/i);
  });

  it('surfaces a transport failure instead of an empty list', async () => {
    mockedBranches.mockRejectedValue(new Error('connection closed'));

    render(<GitBranchesView ctx={ctx()} />);

    expect(await screen.findByTestId('git-branches-error')).toHaveTextContent(
      'connection closed',
    );
  });
});
