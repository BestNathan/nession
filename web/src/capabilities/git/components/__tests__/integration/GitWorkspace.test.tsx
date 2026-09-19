import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWorkspace } from '../../GitWorkspace';
import { gitApi } from '../../../GitPlugin';
import type { GitDiffResponse, GitStatusResponse } from '../../../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import type { DomainState } from '@/product/session/model/domainState';
import type { Agent, Session } from '@/types';

vi.mock('../../../GitPlugin', () => ({
  gitApi: {
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    gitRoot: vi.fn(),
  },
}));

const mockedStatus = vi.mocked(gitApi.gitStatus);
const mockedDiff = vi.mocked(gitApi.gitDiff);

const agent: Agent = {
  agent_id: 'agent-1',
  hostname: 'workstation',
  ip_address: '127.0.0.1',
  port: 19090,
  status: 'online',
  session_count: 1,
  last_heartbeat: '2026-09-06T00:00:00.000Z',
};

const session: Session = {
  session_id: 'agent-1:work',
  agent_id: 'agent-1',
  session_name: 'work',
  status: 'active',
  window_count: 1,
  attached_clients: 1,
  last_activity: '2026-09-06T00:00:00.000Z',
};

const domain: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};

function context(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    session,
    agent,
    agents: [agent],
    domain,
    fileOps: null,
    experience: 'web',
    onToolChange: () => {},
    ...overrides,
  };
}

function statusResponse(overrides: Partial<GitStatusResponse & { state: 'ok' }> = {}) {
  return {
    state: 'ok',
    truncated: false,
    truncatedBytes: 0,
    status: {
      branch: 'main',
      detached: false,
      ahead: 0,
      behind: 0,
      modified: [],
      untracked: [],
      unmerged: [],
    },
    ...overrides,
  } as GitStatusResponse;
}

function diffResponse(text: string, overrides: Partial<GitDiffResponse & { state: 'ok' }> = {}) {
  return {
    state: 'ok',
    diff: { path: 'src/a.ts', text, binary: false, truncatedBytes: 0, truncated: false },
    ...overrides,
  } as GitDiffResponse;
}

describe('GitWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStatus.mockResolvedValue(statusResponse());
    mockedDiff.mockResolvedValue(diffResponse(''));
  });

  it('asks for the state of the Session’s repository, naming the agent to route to', async () => {
    render(<GitWorkspace ctx={context()} />);

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));
    // `agent_id` is routing, not context: without it the server answers
    // "missing agent_id" and the Session never reaches an agent.
    expect(mockedStatus).toHaveBeenCalledWith({ agent_id: 'agent-1', session: 'agent-1:work' });
  });

  it('shows the branch and the ahead/behind relationship (SC1)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'feat/repo-status',
          detached: false,
          upstream: 'origin/feat/repo-status',
          ahead: 2,
          behind: 1,
          modified: [
            { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true },
          ],
          untracked: [],
          unmerged: [],
        },
      }),
    );

    render(<GitWorkspace ctx={context()} />);

    expect(await screen.findByTestId('git-branch')).toHaveTextContent('feat/repo-status');
    expect(screen.getByTestId('git-summary')).toHaveTextContent('2 ahead, 1 behind');
  });

  it('groups modified and untracked, and gives untracked no expander (SC2)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [
            { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true },
          ],
          untracked: ['notes.txt'],
          unmerged: [],
        },
      }),
    );

    render(<GitWorkspace ctx={context()} />);

    expect(await screen.findByTestId('git-group-modified')).toHaveTextContent('Modified (1)');
    expect(screen.getByTestId('git-group-untracked')).toHaveTextContent('Untracked (1)');

    // The tracked row is a control; the untracked one is not a control at all.
    // Not a disabled control — nothing for the user to press and nothing that
    // could open onto an empty diff.
    expect(screen.getByTestId('git-row-tracked')).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByTestId('git-row-untracked')).not.toBeInstanceOf(HTMLButtonElement);
    expect(screen.queryByRole('button', { name: 'notes.txt' })).toBeNull();
  });

  it('does not repeat the group heading on every row, but keeps what it omits', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [
            { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true },
            {
              path: 'src/c.ts',
              originalPath: 'src/b.ts',
              kind: 'renamed',
              staged: true,
              unstaged: false,
            },
          ],
          untracked: ['notes.txt'],
          unmerged: [],
        },
      }),
    );

    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-change-list');

    const rows = screen.getAllByTestId('git-row-tracked');
    // "Modified (2)" already says both are modified; saying it twice more is
    // decoration. `renamed` is not in the heading, so it stays.
    expect(rows[0]).not.toHaveTextContent('modified');
    expect(rows[1]).toHaveTextContent('renamed');
    // The old path cannot fit inline without squeezing the name being read.
    expect(rows[1]).toHaveAttribute('title', 'src/b.ts → src/c.ts');

    // The heading already says untracked, so the row repeats nothing.
    expect(screen.getByTestId('git-row-untracked')).not.toHaveTextContent('untracked');
  });

  it('opens a modified file’s diff, and shows the truncation notice (SC3)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [
            { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true },
          ],
          untracked: [],
          unmerged: [],
        },
      }),
    );
    mockedDiff.mockResolvedValue(
      diffResponse('@@ -1 +1 @@\n-old\n+new\n', {
        diff: {
          path: 'src/a.ts',
          text: '@@ -1 +1 @@\n-old\n+new\n',
          binary: false,
          truncatedBytes: 4096,
          truncated: true,
        },
      } as Partial<GitDiffResponse & { state: 'ok' }>),
    );

    render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-tracked'));

    await waitFor(() => expect(mockedDiff).toHaveBeenCalledTimes(1));
    expect(mockedDiff).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      session: 'agent-1:work',
      path: 'src/a.ts',
    });

    const body = await screen.findByTestId('git-diff-body');
    expect(body).toHaveTextContent('@@ -1 +1 @@');
    expect(body).toHaveTextContent('+new');

    // C3: a half diff presented as a whole one is the failure this prevents.
    expect(screen.getByTestId('git-diff-truncated')).toHaveTextContent('4.0 KB');
  });

  it('reports the truncation of the listing itself, not just of a diff', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({ truncated: true, truncatedBytes: 2048 }),
    );

    render(<GitWorkspace ctx={context()} />);

    expect(await screen.findByTestId('git-summary')).toHaveTextContent('listing truncated');
  });

  it('says a binary file has no line diff rather than showing an empty one', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [
            { path: 'logo.png', kind: 'modified', staged: false, unstaged: true },
          ],
          untracked: [],
          unmerged: [],
        },
      }),
    );
    mockedDiff.mockResolvedValue(
      diffResponse('Binary files a/logo.png and b/logo.png differ', {
        diff: {
          path: 'logo.png',
          text: '',
          binary: true,
          truncatedBytes: 0,
          truncated: false,
        },
      } as Partial<GitDiffResponse & { state: 'ok' }>),
    );

    render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-tracked'));

    expect(await screen.findByTestId('git-diff')).toHaveTextContent('Binary file');
  });

  describe('failure states are readable and distinct (SC4)', () => {
    it('says the Session is not in a repository', async () => {
      mockedStatus.mockResolvedValue({ state: 'not_a_repository' });

      render(<GitWorkspace ctx={context()} />);

      const panel = await screen.findByTestId('git-unavailable');
      expect(panel).toHaveAttribute('data-state', 'not_a_repository');
      expect(panel).toHaveTextContent(/not in a git repository/i);
    });

    it('says git is missing, which is a different problem with a different fix', async () => {
      mockedStatus.mockResolvedValue({ state: 'unavailable', reason: 'git_not_installed' });

      render(<GitWorkspace ctx={context()} />);

      const panel = await screen.findByTestId('git-unavailable');
      expect(panel).toHaveTextContent(/git is not installed/i);
      expect(panel).toHaveTextContent(/install git/i);
    });

    it('surfaces the agent’s own message for an error', async () => {
      mockedStatus.mockResolvedValue({
        state: 'error',
        message: 'fatal: detected dubious ownership in repository',
      });

      render(<GitWorkspace ctx={context()} />);

      expect(await screen.findByTestId('git-unavailable')).toHaveTextContent(
        'dubious ownership',
      );
    });

    it('reports a transport failure without rendering a disabled capability', async () => {
      mockedStatus.mockRejectedValue(new Error('connection closed'));

      render(<GitWorkspace ctx={context()} />);

      const notice = await screen.findByTestId('git-transport-error');
      expect(notice).toHaveTextContent('connection closed');
      // The capability is present and usable; the failure is content, not a
      // greyed-out slot.
      expect(screen.getByTestId('git-workspace')).toBeInTheDocument();
    });
  });

  it('says a clean tree is clean, with no badge and nothing to act on (C5)', async () => {
    render(<GitWorkspace ctx={context()} />);

    expect(await screen.findByTestId('git-summary')).toHaveTextContent('Working tree clean');
    expect(screen.getByTestId('git-clean')).toHaveTextContent('Nothing has changed');
    // No diff pane: with nothing to open, it has no subject.
    expect(screen.queryByTestId('git-change-list')).toBeNull();
    // The only control on a clean screen is Refresh — a read.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByTestId('git-refresh')).toBeInTheDocument();
  });

  it('offers no control that could write to the repository (SC5)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 1,
          behind: 0,
          modified: [
            { path: 'src/a.ts', kind: 'modified', staged: true, unstaged: false },
            { path: 'src/b.ts', kind: 'modified', staged: false, unstaged: true },
          ],
          untracked: ['notes.txt'],
          unmerged: ['both.ts'],
        },
      }),
    );

    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-change-list');

    // Two reads (the two tracked rows) and one refresh. Nothing else is
    // pressable, so there is no affordance for stage/commit/checkout/push.
    const labels = screen.getAllByRole('button').map(
      (button) => button.getAttribute('aria-label') ?? button.textContent ?? '',
    );
    expect(labels.sort()).toEqual(['Refresh repository state', 'src/a.ts', 'src/b.ts']);
    expect(screen.queryByRole('button', { name: /commit|stage|push|pull|checkout|discard/i })).toBeNull();
  });

  it('offers the refresh control to ask again', async () => {
    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-clean');

    await userEvent.click(screen.getByTestId('git-refresh'));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
  });

  it('asks for nothing when there is no Session to ask about', async () => {
    render(<GitWorkspace ctx={context({ session: null })} />);

    expect(screen.getByTestId('git-no-session')).toHaveTextContent('Select a Session');
    expect(mockedStatus).not.toHaveBeenCalled();
  });
});
