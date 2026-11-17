import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHistoryView } from '../../GitHistoryView';
import { gitApi } from '../../../GitPlugin';
import type {
  GitCommit,
  GitCommitResponse,
  GitInvalidatedEvent,
  GitLogResponse,
} from '../../../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import type { Agent, Session } from '@/types';

vi.mock('../../../GitPlugin', () => ({
  gitApi: {
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    gitRoot: vi.fn(),
    gitLog: vi.fn(),
    gitCommit: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
  },
}));

const mockedLog = vi.mocked(gitApi.gitLog);
const mockedCommit = vi.mocked(gitApi.gitCommit);
const mockedOnInvalidated = vi.mocked(gitApi.onInvalidated);

const agent = { agent_id: 'a1', hostname: 'devbox' } as Agent;
const session = { session_id: 'a1:work', agent_id: 'a1', session_name: 'work' } as Session;
const otherSession = {
  session_id: 'a1:design-system',
  agent_id: 'a1',
  session_name: 'design-system',
} as Session;

function ctx(forSession: Session = session): WorkspaceContext {
  return {
    session: forSession,
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
    short_hash: 'aaaaaaa',
    author: 'Nathan',
    relative_date: '2 hours ago',
    date: '2026-09-19T14:20:00+08:00',
    subject: 'feat: something',
    refs: '',
    ...overrides,
  };
}

function ok(commits: GitCommit[], extra: Partial<GitLogResponse & { state: 'ok' }> = {}) {
  const limit = commits.length;
  return {
    state: 'ok',
    history: {
      commits,
      limit,
      truncated_bytes: 0,
      truncated: false,
      end_of_history: true,
      next_cursor: undefined,
    },
    ...extra,
  } as GitLogResponse;
}

/** A row whose visible subject identifies the page it came from. */
function labeled(label: string, index: number): GitCommit {
  const seed = `${label}${index}`;
  const hash = seed.repeat(Math.ceil(40 / seed.length)).slice(0, 40);
  return commit({ hash, short_hash: hash.slice(0, 7), subject: `${label} ${index}` });
}

/** A page that continues while `cursor` is present, and ends without one. */
function paged(rows: GitCommit[], cursor?: string): GitLogResponse {
  return {
    state: 'ok',
    history: {
      commits: rows,
      limit: rows.length,
      truncated_bytes: 0,
      truncated: false,
      end_of_history: !cursor,
      next_cursor: cursor,
    },
  } as GitLogResponse;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function commitDetailFrom(row: GitCommit) {
  return {
    state: 'ok' as const,
    commit: {
      oid: row.hash,
      short_oid: row.short_hash,
      parents: ['p'.repeat(40)],
      author: row.author,
      author_date: row.date,
      committer: row.author,
      commit_date: row.date,
      subject: row.subject,
      body: '',
      decorations: row.refs,
      files: [{ path: 'README.md', status: 'M', binary: false }],
      files_truncated: false,
      files_truncated_bytes: 0,
      message_truncated: false,
      message_truncated_bytes: 0,
      merge_diff_parent: row.hash,
    },
  } satisfies GitCommitResponse;
}

describe('GitHistoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedOnInvalidated.mockImplementation(() => () => {});
    mockedLog.mockResolvedValue(ok([commit()]));
    mockedCommit.mockImplementation(async (req) => {
      const row = commit({ hash: req.oid, short_hash: req.oid.slice(0, 7) });
      return commitDetailFrom(row);
    });
  });

  it('asks the agent for history, naming the agent to route to', async () => {
    render(<GitHistoryView ctx={ctx()} />);

    expect(await screen.findByTestId('git-commit-list')).toBeInTheDocument();
    expect(mockedLog).toHaveBeenCalledWith({ agent_id: 'a1', session: 'a1:work' });
  });

  it('lists commits newest-first with what identifies each one', async () => {
    mockedLog.mockResolvedValue(
      ok([
        commit({ hash: 'b'.repeat(40), short_hash: 'bbbbbbb', subject: 'newer' }),
        commit({ hash: 'a'.repeat(40), short_hash: 'aaaaaaa', subject: 'older' }),
      ]),
    );

    render(<GitHistoryView ctx={ctx()} />);

    const rows = await screen.findAllByTestId('git-commit-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'newerbbbbbbbNathan2 hours ago',
      'olderaaaaaaaNathan2 hours ago',
    ]);
  });

  it('loads commit detail when a row is selected', async () => {
    render(<GitHistoryView ctx={ctx()} />);

    await userEvent.click((await screen.findAllByTestId('git-commit-row'))[0]);

    const detail = await screen.findByTestId('git-commit-detail');
    expect(detail).toHaveTextContent('feat: something');
    expect(detail).toHaveTextContent('a'.repeat(40));
    expect(detail).toHaveTextContent('README.md');
    expect(mockedCommit).toHaveBeenCalledWith({
      agent_id: 'a1',
      session: 'a1:work',
      oid: 'a'.repeat(40),
    });
  });

  it('shows refs only when a commit has them', async () => {
    const withRefs = commit({ hash: 'b'.repeat(40), refs: 'HEAD -> main' });
    const noRefs = commit({ hash: 'a'.repeat(40), refs: '' });
    mockedLog.mockResolvedValue(ok([withRefs, noRefs]));
    mockedCommit.mockImplementation(async (req) => {
      if (req.oid === withRefs.hash) {
        return commitDetailFrom(withRefs);
      }
      return commitDetailFrom(noRefs);
    });

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
        history: {
          commits,
          limit: 2,
          truncated_bytes: 0,
          truncated: false,
          end_of_history: true,
        },
      }),
    );

    render(<GitHistoryView ctx={ctx()} />);

    expect(await screen.findByTestId('git-history-more')).toHaveTextContent('End of history');
    expect(screen.getByTestId('git-history-more')).toHaveTextContent('2 commits loaded');
  });

  it('does not claim there is more when the answer is not full', async () => {
    // A short answer is a complete answer. Offering "older commits are not
    // loaded" over a repository whose whole history is on screen is a lie the
    // reader would act on.
    mockedLog.mockResolvedValue(
      ok([commit()], {
        history: {
          commits: [commit()],
          limit: 50,
          truncated_bytes: 0,
          truncated: false,
          end_of_history: true,
        },
      }),
    );

    render(<GitHistoryView ctx={ctx()} />);

    await screen.findByTestId('git-commit-list');
    expect(screen.queryByTestId('git-history-more')).toBeNull();
  });

  it('reports truncation rather than a history that quietly stops', async () => {
    mockedLog.mockResolvedValue(
      ok([commit()], {
        history: {
          commits: [commit()],
          limit: 1,
          truncated_bytes: 4096,
          truncated: true,
          end_of_history: true,
        },
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

  // #3751: an older page is a second question about a list the first page
  // established. The list's owner is the target plus the exact first-page
  // answer; an answer for a list that was replaced may not publish into the
  // one now on screen.
  it('drops an older page that settles after the Session moved on (#3751 SC-01)', async () => {
    const heldOlder = deferred<GitLogResponse>();
    mockedLog.mockImplementation((request) => {
      if (request.session === session.session_id) {
        return request.before
          ? heldOlder.promise
          : Promise.resolve(paged([labeled('a', 1), labeled('a', 2)], 'cursor-a'));
      }
      return request.before
        ? Promise.resolve(paged([labeled('b older', 1)]))
        : Promise.resolve(paged([labeled('b', 1), labeled('b', 2)], 'cursor-b'));
    });

    const view = render(<GitHistoryView ctx={ctx()} />);
    await screen.findByTestId('git-commit-list');
    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(mockedLog).toHaveBeenLastCalledWith({
      agent_id: 'a1',
      session: 'a1:work',
      before: 'cursor-a',
    });

    // The Session moves while A's older page is still in flight. B's first
    // page establishes B's list.
    view.rerender(<GitHistoryView ctx={ctx(otherSession)} />);
    expect(await screen.findByText('b 1')).toBeInTheDocument();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);

    // A's older page now arrives. It describes A's repository and A's list.
    await act(async () => {
      heldOlder.resolve(paged([labeled('a older', 1)]));
    });

    expect(screen.queryByText('a older 1')).toBeNull();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent('Load older commits');
    expect(screen.getByTestId('git-history-load-more')).toBeEnabled();

    // B's own continuation still starts from B's cursor: the stale answer
    // neither appended nor rolled the continuation boundary back.
    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(mockedLog).toHaveBeenLastCalledWith({
      agent_id: 'a1',
      session: 'a1:design-system',
      before: 'cursor-b',
    });
    expect(await screen.findByText('b older 1')).toBeInTheDocument();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(3);
  });

  it('a refresh replaces the list and fences both a stale page and its loading reset (#3751 SC-02)', async () => {
    const olderGenerationOne = deferred<GitLogResponse>();
    const olderGenerationTwo = deferred<GitLogResponse>();
    let firstPageReads = 0;
    mockedLog.mockImplementation((request) => {
      if (request.before === 'cursor-1') {
        return olderGenerationOne.promise;
      }
      if (request.before === 'cursor-2') {
        return olderGenerationTwo.promise;
      }
      firstPageReads += 1;
      return firstPageReads === 1
        ? Promise.resolve(paged([labeled('a', 1), labeled('a', 2)], 'cursor-1'))
        : Promise.resolve(paged([labeled('g2', 1), labeled('g2', 2)], 'cursor-2'));
    });

    render(<GitHistoryView ctx={ctx()} />);
    await screen.findByText('a 1');
    await userEvent.click(screen.getByTestId('git-history-load-more'));

    // A manual Refresh answers first, replacing the first page and the list.
    await userEvent.click(
      within(screen.getByTestId('git-commit-list')).getByRole('button', { name: 'Refresh' }),
    );
    expect(await screen.findByText('g2 1')).toBeInTheDocument();
    expect(screen.queryByText('a 1')).toBeNull();

    // The refreshed list starts its own older read, still in flight.
    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent(
      'Loading older commits…',
    );

    // The generation-one answer settles now. It may not append, and its
    // terminal state may not clear the generation-two read's loading flag.
    await act(async () => {
      olderGenerationOne.resolve(paged([labeled('stale', 1)]));
    });
    expect(screen.queryByText('stale 1')).toBeNull();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent(
      'Loading older commits…',
    );
    expect(screen.getByTestId('git-history-load-more')).toBeDisabled();

    // The unchanged-generation continuation appends once and ends the log.
    await act(async () => {
      olderGenerationTwo.resolve(paged([labeled('g2 older', 1)]));
    });
    expect(await screen.findByText('g2 older 1')).toBeInTheDocument();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(3);
    expect(screen.queryByTestId('git-history-load-more')).toBeNull();
  });

  it('an invalidation replaces the first page and fences a held older page (#3751 SC-02)', async () => {
    const listeners: Array<(event: GitInvalidatedEvent) => void> = [];
    mockedOnInvalidated.mockImplementation((listener) => {
      listeners.push(listener);
      return () => {};
    });
    const heldOlder = deferred<GitLogResponse>();
    let firstPageReads = 0;
    mockedLog.mockImplementation((request) => {
      if (request.before === 'cursor-1') {
        return heldOlder.promise;
      }
      firstPageReads += 1;
      return firstPageReads === 1
        ? Promise.resolve(paged([labeled('a', 1)], 'cursor-1'))
        : Promise.resolve(paged([labeled('g2', 1)], 'cursor-2'));
    });

    render(<GitHistoryView ctx={ctx()} />);
    await screen.findByText('a 1');
    await userEvent.click(screen.getByTestId('git-history-load-more'));

    // The agent reports the repository changed; the first page is read again.
    await act(async () => {
      for (const listener of listeners) {
        listener({ agent_id: 'a1', session: 'a1:work', epoch: 1, reason: 'invalidated' });
      }
    });
    expect(await screen.findByText('g2 1')).toBeInTheDocument();
    expect(screen.queryByText('a 1')).toBeNull();

    await act(async () => {
      heldOlder.resolve(paged([labeled('stale', 1)]));
    });
    expect(screen.queryByText('stale 1')).toBeNull();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(1);
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent('Load older commits');
    expect(screen.getByTestId('git-history-load-more')).toBeEnabled();
  });
});
