import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHistoryView } from '../../GitHistoryView';
import { gitApi } from '../../../GitPlugin';
import type { GitCommit, GitLogResponse } from '../../../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import type { Agent, Session } from '@/types';

vi.mock('../../../GitPlugin', () => ({
  gitApi: {
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    gitRoot: vi.fn(),
    gitLog: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
  },
}));

const mockedLog = vi.mocked(gitApi.gitLog);

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

function commit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    author: 'Nathan',
    relativeDate: '2 hours ago',
    date: '2026-09-19T14:20:00+08:00',
    subject: 'feat: something',
    refs: '',
    ...overrides,
  };
}

function ok(commits: GitCommit[], extra: Partial<GitLogResponse & { state: 'ok' }> = {}) {
  return {
    state: 'ok',
    history: { commits, limit: commits.length, truncatedBytes: 0, truncated: false },
    ...extra,
  } as GitLogResponse;
}

describe('GitHistoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLog.mockResolvedValue(ok([commit()]));
  });

  it('asks the agent for history, naming the agent to route to', async () => {
    render(<GitHistoryView ctx={ctx()} />);

    expect(await screen.findByTestId('git-commit-list')).toBeInTheDocument();
    expect(mockedLog).toHaveBeenCalledWith({ agent_id: 'a1', session: 'a1:work' });
  });

  it('lists commits newest-first with what identifies each one', async () => {
    mockedLog.mockResolvedValue(
      ok([
        commit({ hash: 'b'.repeat(40), shortHash: 'bbbbbbb', subject: 'newer' }),
        commit({ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'older' }),
      ]),
    );

    render(<GitHistoryView ctx={ctx()} />);

    const rows = await screen.findAllByTestId('git-commit-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'newerbbbbbbbNathan2 hours ago',
      'olderaaaaaaaNathan2 hours ago',
    ]);
  });

  it('shows which commit is selected, and says what it is not showing', async () => {
    // A commit patch is a diff of unknown size and is deliberately not here.
    // Saying so on the screen is cheaper than a reader concluding its absence is
    // a bug.
    render(<GitHistoryView ctx={ctx()} />);

    await userEvent.click((await screen.findAllByTestId('git-commit-row'))[0]);

    const detail = await screen.findByTestId('git-commit-detail');
    expect(detail).toHaveTextContent('feat: something');
    expect(detail).toHaveTextContent('a'.repeat(40));
    expect(detail).toHaveTextContent('not shown here');
  });

  it('shows refs only when a commit has them', async () => {
    mockedLog.mockResolvedValue(
      ok([
        commit({ hash: 'b'.repeat(40), refs: 'HEAD -> main' }),
        commit({ hash: 'a'.repeat(40), refs: '' }),
      ]),
    );

    const view = render(<GitHistoryView ctx={ctx()} />);
    const rows = await screen.findAllByTestId('git-commit-row');

    await userEvent.click(rows[0]);
    expect(await screen.findByTestId('git-commit-detail')).toHaveTextContent('HEAD -> main');

    // An empty Refs row would read as "this commit has no refs" rather than
    // "refs are not a thing here".
    await userEvent.click(rows[1]);
    expect(screen.getByTestId('git-commit-detail')).not.toHaveTextContent('Refs');
    view.unmount();
  });

  it('says when the answer is only the most recent N', async () => {
    // The list is full to the limit, which is the only state in which the agent
    // might be holding more back.
    const commits = [
      commit({ hash: 'b'.repeat(40) }),
      commit({ hash: 'a'.repeat(40) }),
    ];
    mockedLog.mockResolvedValue(
      ok(commits, {
        history: { commits, limit: 2, truncatedBytes: 0, truncated: false },
      }),
    );

    render(<GitHistoryView ctx={ctx()} />);

    // The count that was answered for, not a guess: `limit` is what the agent
    // clamped to, so the notice cannot promise more than exists.
    expect(await screen.findByTestId('git-history-more')).toHaveTextContent('most recent 2');
  });

  it('does not claim there is more when the answer is not full', async () => {
    // A short answer is a complete answer. Offering "older commits are not
    // loaded" over a repository whose whole history is on screen is a lie the
    // reader would act on.
    mockedLog.mockResolvedValue(
      ok([commit()], {
        history: { commits: [commit()], limit: 50, truncatedBytes: 0, truncated: false },
      }),
    );

    render(<GitHistoryView ctx={ctx()} />);

    await screen.findByTestId('git-commit-list');
    expect(screen.queryByTestId('git-history-more')).toBeNull();
  });

  it('reports truncation rather than a history that quietly stops', async () => {
    mockedLog.mockResolvedValue(
      ok([commit()], {
        history: { commits: [commit()], limit: 1, truncatedBytes: 4096, truncated: true },
      }),
    );

    render(<GitHistoryView ctx={ctx()} />);

    expect(await screen.findByTestId('git-history-truncated')).toHaveTextContent('4.0 KB');
  });

  it('tells an empty repository apart from a failure', async () => {
    // `git init` and nothing else is a real state, not an error.
    mockedLog.mockResolvedValue(ok([]));

    render(<GitHistoryView ctx={ctx()} />);

    expect(await screen.findByTestId('git-history-none')).toHaveTextContent('no commits yet');
  });

  it('reports the agent’s failure states with their own copy', async () => {
    mockedLog.mockResolvedValue({ state: 'not_a_repository', message: 'not a git repository' });

    render(<GitHistoryView ctx={ctx()} />);

    const panel = await screen.findByTestId('git-history-unavailable');
    expect(panel).toHaveAttribute('data-state', 'not_a_repository');
    expect(panel).toHaveTextContent(/not in a git repository/i);
  });

  it('surfaces a transport failure instead of an empty list', async () => {
    mockedLog.mockRejectedValue(new Error('connection closed'));

    render(<GitHistoryView ctx={ctx()} />);

    expect(await screen.findByTestId('git-history-error')).toHaveTextContent('connection closed');
  });
});
