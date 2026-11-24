import { act, render, screen, waitFor, within } from '@testing-library/react';
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
const mockedDiff = vi.mocked(gitApi.gitDiff);
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
    mockedDiff.mockResolvedValue({
      state: 'ok',
      diff: {
        path: 'README.md',
        text: '@@ -1 +1 @@\n-old\n+new\n',
        binary: false,
        truncated_bytes: 0,
        truncated: false,
      },
      snapshot: { token: 'fixture', head: null, root: '/repo' },
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

  // #3767: the selection is a question about one repository's commit. It may
  // not survive a Session switch or a first page that no longer lists its row,
  // and no request for the predecessor's OID may be addressed to the successor.
  it('drops a commit and file selection when the Session target changes (#3767 SC-01)', async () => {
    const a1 = labeled('a', 1);
    const a2 = labeled('a', 2);
    const b1 = labeled('b', 1);
    const b2 = labeled('b', 2);
    mockedLog.mockImplementation((request) =>
      request.session === session.session_id
        ? Promise.resolve(paged([a1, a2]))
        : Promise.resolve(paged([b1, b2])),
    );
    mockedCommit.mockImplementation(async (req) => {
      const row = [a1, a2, b1, b2].find((candidate) => candidate.hash === req.oid);
      return row
        ? commitDetailFrom(row)
        : { state: 'error' as const, message: `unknown revision: ${req.oid}` };
    });

    const view = render(<GitHistoryView ctx={ctx()} />);
    await userEvent.click(await screen.findByText('a 1'));
    expect(await screen.findByTestId('git-commit-detail')).toHaveTextContent('a 1');
    await userEvent.click(screen.getByTestId('git-commit-file-row'));
    expect(await screen.findByTestId('git-diff')).toBeInTheDocument();

    expect(mockedCommit).toHaveBeenLastCalledWith({
      agent_id: 'a1',
      session: session.session_id,
      oid: a1.hash,
    });
    expect(mockedDiff).toHaveBeenLastCalledWith({
      agent_id: 'a1',
      session: session.session_id,
      path: 'README.md',
      source: { kind: 'commit', oid: a1.hash },
    });

    // The Workspace moves to another Session while that selection is on
    // screen. B's first page establishes B's list.
    view.rerender(<GitHistoryView ctx={ctx(otherSession)} />);
    expect(await screen.findByText('b 1')).toBeInTheDocument();

    // No A row is current, and there is no detail or diff attached to one.
    expect(screen.queryByTestId('git-commit-detail')).toBeNull();
    expect(screen.queryByTestId('git-diff')).toBeNull();
    expect(screen.getByTestId('git-commit-empty')).toBeInTheDocument();
    expect(
      screen.getByTestId('git-commit-list').querySelector('[aria-current="true"]'),
    ).toBeNull();

    // The successor was never asked about the predecessor's commit — neither
    // for its detail nor for its diff.
    expect(mockedCommit).not.toHaveBeenCalledWith(
      expect.objectContaining({ session: otherSession.session_id, oid: a1.hash }),
    );
    expect(mockedDiff).not.toHaveBeenCalledWith(
      expect.objectContaining({ session: otherSession.session_id }),
    );

    // B's own commit selects normally, and the detail request names B.
    await userEvent.click(screen.getByText('b 2'));
    expect(await screen.findByTestId('git-commit-detail')).toHaveTextContent('b 2');
    expect(mockedCommit).toHaveBeenLastCalledWith({
      agent_id: 'a1',
      session: otherSession.session_id,
      oid: b2.hash,
    });
    expect(
      screen.getByTestId('git-commit-list').querySelectorAll('[aria-current="true"]'),
    ).toHaveLength(1);
  });

  it('drops an orphaned selection when a refreshed first page no longer lists it (#3767 SC-02)', async () => {
    const g1a = labeled('g1', 1);
    const g1b = labeled('g1', 2);
    const g2a = labeled('g2', 1);
    const g2b = labeled('g2', 2);
    const older = labeled('g2 older', 1);
    const rows = [g1a, g1b, g2a, g2b, older];
    let firstPageReads = 0;
    mockedLog.mockImplementation((request) => {
      if (request.before === 'cursor-gen2') {
        return Promise.resolve(paged([older]));
      }
      firstPageReads += 1;
      return firstPageReads === 1
        ? Promise.resolve(paged([g1a, g1b], 'cursor-gen1'))
        : Promise.resolve(paged([g2a, g2b], 'cursor-gen2'));
    });
    mockedCommit.mockImplementation(async (req) => {
      const row = rows.find((candidate) => candidate.hash === req.oid);
      return row
        ? commitDetailFrom(row)
        : { state: 'error' as const, message: `unknown revision: ${req.oid}` };
    });

    render(<GitHistoryView ctx={ctx()} />);
    await userEvent.click(await screen.findByText('g1 1'));
    expect(await screen.findByTestId('git-commit-detail')).toHaveTextContent('g1 1');
    await userEvent.click(screen.getByTestId('git-commit-file-row'));
    expect(await screen.findByTestId('git-diff')).toBeInTheDocument();

    // A refresh replaces the first page with generation two, which no longer
    // contains the selected commit. The row the detail belonged to is gone.
    await userEvent.click(
      within(screen.getByTestId('git-commit-list')).getByRole('button', { name: 'Refresh' }),
    );
    expect(await screen.findByText('g2 1')).toBeInTheDocument();
    expect(screen.queryByTestId('git-commit-detail')).toBeNull();
    expect(screen.queryByTestId('git-diff')).toBeNull();
    expect(screen.getByTestId('git-commit-empty')).toBeInTheDocument();
    expect(
      screen.getByTestId('git-commit-list').querySelector('[aria-current="true"]'),
    ).toBeNull();
    // The replacement did not re-read the dropped commit.
    expect(
      mockedCommit.mock.calls.filter(([request]) => request.oid === g1a.hash),
    ).toHaveLength(1);

    // Ordinary paging and selection stay usable: selecting a refreshed commit
    // survives loading an older page, and a commit from that appended page is
    // itself selectable.
    await userEvent.click(screen.getByText('g2 2'));
    expect(await screen.findByTestId('git-commit-detail')).toHaveTextContent('g2 2');
    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(await screen.findByText('g2 older 1')).toBeInTheDocument();
    expect(screen.getByTestId('git-commit-detail')).toHaveTextContent('g2 2');
    const currentRows = screen
      .getByTestId('git-commit-list')
      .querySelectorAll('[aria-current="true"]');
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0]).toHaveTextContent('g2 2');

    await userEvent.click(screen.getByText('g2 older 1'));
    expect(await screen.findByTestId('git-commit-detail')).toHaveTextContent('g2 older 1');
    expect(mockedCommit).toHaveBeenLastCalledWith({
      agent_id: 'a1',
      session: session.session_id,
      oid: older.hash,
    });
  });

  it('keeps a selection while a refreshed first page still lists the commit (#3767 SC-02)', async () => {
    const first = labeled('kept', 1);
    const second = labeled('kept', 2);
    mockedLog.mockImplementation(() => Promise.resolve(paged([first, second])));
    mockedCommit.mockImplementation(async (req) => {
      const row = [first, second].find((candidate) => candidate.hash === req.oid);
      return row
        ? commitDetailFrom(row)
        : { state: 'error' as const, message: `unknown revision: ${req.oid}` };
    });

    render(<GitHistoryView ctx={ctx()} />);
    await userEvent.click(await screen.findByText('kept 2'));
    expect(await screen.findByTestId('git-commit-detail')).toHaveTextContent('kept 2');

    // The replacement answer lists the same commit, so the selection is not
    // orphaned and must survive the refresh.
    await userEvent.click(
      within(screen.getByTestId('git-commit-list')).getByRole('button', { name: 'Refresh' }),
    );
    await waitFor(() => expect(mockedLog).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('git-commit-detail')).toHaveTextContent('kept 2');
    expect(
      screen.getByTestId('git-commit-list').querySelectorAll('[aria-current="true"]'),
    ).toHaveLength(1);
    expect(
      mockedCommit.mock.calls.filter(([request]) => request.oid === second.hash),
    ).toHaveLength(1);
  });

  // #4141 SC-01: a rejected continuation must not produce an unhandled
  // rejection, must keep the first page and cursor intact, must clear loading,
  // and must present a visible retryable error. The existing Load Older action
  // is itself the retry.
  it('handles a rejected older-page read with a visible retry and keeps the first page (#4141 SC-01)', async () => {
    let olderShouldFail = true;
    mockedLog.mockImplementation((request) => {
      if (request.before === 'cursor-a') {
        return olderShouldFail
          ? Promise.reject(new Error('connection reset'))
          : Promise.resolve(paged([labeled('a older', 1)]));
      }
      return Promise.resolve(paged([labeled('a', 1), labeled('a', 2)], 'cursor-a'));
    });

    render(<GitHistoryView ctx={ctx()} />);
    expect(await screen.findByText('a 1')).toBeInTheDocument();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);

    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(await screen.findByTestId('git-history-older-error')).toHaveTextContent(
      'Could not load older commits. Try again.',
    );

    // The first page is still on screen and the cursor is preserved: the
    // rejected continuation did not drop the list it was extending.
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);
    expect(screen.getByText('a 1')).toBeInTheDocument();
    expect(screen.getByText('a 2')).toBeInTheDocument();

    // Loading cleared: the retry action is enabled again.
    expect(screen.getByTestId('git-history-load-more')).toBeEnabled();
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent('Load older commits');

    // The same Load Older action is the retry. Flip the failure off and retry.
    olderShouldFail = false;
    await userEvent.click(screen.getByTestId('git-history-load-more'));

    expect(await screen.findByText('a older 1')).toBeInTheDocument();
    expect(screen.queryByTestId('git-history-older-error')).toBeNull();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(3);
  });

  // #4141 SC-02: a late rejected continuation for a replaced target or
  // generation must not publish its error into the successor's list, and must
  // not clear the successor's own loading state. The #3751 fence covers both
  // halves of a read — its data and its terminal state — and rejection is no
  // exception.
  it('a late rejected older-page read for a stale target cannot publish error or clear the successor loading (#4141 SC-02)', async () => {
    const heldOlder = {
      promise: new Promise<GitLogResponse>(() => {}),
      reject: null as null | ((reason: unknown) => void),
    };
    heldOlder.promise = new Promise<GitLogResponse>((_, setReject) => {
      heldOlder.reject = setReject;
    });
    const heldSuccessor = deferred<GitLogResponse>();
    mockedLog.mockImplementation((request) => {
      if (request.session === session.session_id && request.before === 'cursor-a') {
        return heldOlder.promise;
      }
      if (request.session === otherSession.session_id) {
        return request.before
          ? heldSuccessor.promise
          : Promise.resolve(paged([labeled('b', 1), labeled('b', 2)], 'cursor-b'));
      }
      return Promise.resolve(paged([labeled('a', 1), labeled('a', 2)], 'cursor-a'));
    });

    const view = render(<GitHistoryView ctx={ctx()} />);
    await screen.findByTestId('git-commit-list');
    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent(
      'Loading older commits…',
    );

    // The Session moves while A's older read is still in flight. B's first
    // page establishes B's list and B's own continuation.
    view.rerender(<GitHistoryView ctx={ctx(otherSession)} />);
    expect(await screen.findByText('b 1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent(
      'Loading older commits…',
    );

    // A's older read now rejects. It belongs to A's list, not B's — it must
    // neither surface an error in B's panel nor clear B's loading flag.
    await act(async () => {
      heldOlder.reject!(new Error('connection closed'));
    });

    expect(screen.queryByTestId('git-history-older-error')).toBeNull();
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent(
      'Loading older commits…',
    );
    expect(screen.getByTestId('git-history-load-more')).toBeDisabled();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);

    // Settling B's own continuation still appends normally after A's stale
    // failure, with B's loading and cursor remaining independently owned.
    await act(async () => {
      heldSuccessor.resolve(paged([labeled('b older', 1)]));
    });
    expect(await screen.findByText('b older 1')).toBeInTheDocument();
    expect(screen.queryByTestId('git-history-older-error')).toBeNull();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(3);
  });

  // #4116: a fulfilled non-ok answer is a domain answer, not a transport
  // failure. It describes no page, so the loaded list and cursor stay and the
  // same Load Older control is the retry; the reason is shown beside it.
  it('shows a fulfilled non-OK older-page answer as a retryable error (#4116)', async () => {
    let repositoryGone = true;
    mockedLog.mockImplementation((request) => {
      if (request.before === 'cursor-a') {
        return repositoryGone
          ? Promise.resolve({
              state: 'not_a_repository' as const,
              message: 'the Session directory is no longer a git repository',
            })
          : Promise.resolve(paged([labeled('a older', 1)]));
      }
      return Promise.resolve(paged([labeled('a', 1), labeled('a', 2)], 'cursor-a'));
    });

    render(<GitHistoryView ctx={ctx()} />);
    expect(await screen.findByText('a 1')).toBeInTheDocument();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);

    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(await screen.findByTestId('git-history-older-error')).toHaveTextContent(
      'This Session is not in a git repository',
    );

    // The first page and the cursor it handed out survive the answer that
    // described no page; the control is enabled and is itself the retry.
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);
    expect(screen.getByText('a 1')).toBeInTheDocument();
    expect(screen.getByText('a 2')).toBeInTheDocument();
    expect(screen.getByTestId('git-history-load-more')).toBeEnabled();
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent('Load older commits');

    repositoryGone = false;
    await userEvent.click(screen.getByTestId('git-history-load-more'));

    expect(await screen.findByText('a older 1')).toBeInTheDocument();
    expect(screen.queryByTestId('git-history-older-error')).toBeNull();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(3);
  });

  // #4116 SC-02 shape: the non-ok path reaches the same fence as rejection. A
  // late answer for a replaced target may neither publish its copy nor clear
  // the successor's loading state.
  it('a late non-OK older-page answer for a stale target cannot publish into the successor (#4116)', async () => {
    const heldOlder = deferred<GitLogResponse>();
    const heldSuccessor = deferred<GitLogResponse>();
    mockedLog.mockImplementation((request) => {
      if (request.session === session.session_id && request.before === 'cursor-a') {
        return heldOlder.promise;
      }
      if (request.session === otherSession.session_id) {
        return request.before
          ? heldSuccessor.promise
          : Promise.resolve(paged([labeled('b', 1), labeled('b', 2)], 'cursor-b'));
      }
      return Promise.resolve(paged([labeled('a', 1), labeled('a', 2)], 'cursor-a'));
    });

    const view = render(<GitHistoryView ctx={ctx()} />);
    await screen.findByTestId('git-commit-list');
    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent(
      'Loading older commits…',
    );

    // The Session moves while A's older read is still in flight. B's first
    // page establishes B's list and B's own continuation.
    view.rerender(<GitHistoryView ctx={ctx(otherSession)} />);
    expect(await screen.findByText('b 1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('git-history-load-more'));
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent(
      'Loading older commits…',
    );

    // A's continuation now fulfils with a non-ok answer. It belongs to A's
    // list, not B's — B must see neither the copy nor a loading-state change.
    await act(async () => {
      heldOlder.resolve({
        state: 'not_a_repository',
        message: 'the Session directory is no longer a git repository',
      });
    });

    expect(screen.queryByTestId('git-history-older-error')).toBeNull();
    expect(screen.getByTestId('git-history-load-more')).toHaveTextContent(
      'Loading older commits…',
    );
    expect(screen.getByTestId('git-history-load-more')).toBeDisabled();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(2);

    // B's own continuation still appends normally after A's stale non-ok
    // answer, with B's loading and cursor remaining independently owned.
    await act(async () => {
      heldSuccessor.resolve(paged([labeled('b older', 1)]));
    });
    expect(await screen.findByText('b older 1')).toBeInTheDocument();
    expect(screen.queryByTestId('git-history-older-error')).toBeNull();
    expect(screen.getAllByTestId('git-commit-row')).toHaveLength(3);
  });
});
