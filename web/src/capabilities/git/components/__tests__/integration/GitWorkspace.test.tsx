import { act, render, screen, waitFor } from '@testing-library/react';import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWorkspace } from '../../GitWorkspace';
import { gitApi } from '../../../GitPlugin';
import { githubApi } from '../../../GithubPlugin';
import type {
  GitDiffResponse,
  GitFilePreview,
  GitPreviewResponse,
  GitStatusResponse,
} from '../../../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import type { DomainState } from '@/product/session/model/domainState';
import type { Agent, Session } from '@/types';

vi.mock('../../../GithubPlugin', () => ({
  githubApi: { repository: vi.fn() },
}));

vi.mock('../../../GitPlugin', () => ({
  gitApi: {
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    gitPreview: vi.fn(),
    gitStage: vi.fn(),
    gitUnstage: vi.fn(),
    gitCreateCommit: vi.fn(),
    gitRoot: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
  },
}));

const mockedStatus = vi.mocked(gitApi.gitStatus);
const mockedRepository = vi.mocked(githubApi.repository);
const mockedDiff = vi.mocked(gitApi.gitDiff);
const mockedPreview = vi.mocked(gitApi.gitPreview);
const mockedStage = vi.mocked(gitApi.gitStage);
const mockedUnstage = vi.mocked(gitApi.gitUnstage);
const mockedCreateCommit = vi.mocked(gitApi.gitCreateCommit);

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
    truncated_bytes: 0,
    root: '/repo',
    snapshot: { token: 'token-1', head: 'head-1', root: '/repo' },
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
    diff: { path: 'src/a.ts', text, binary: false, truncated_bytes: 0, truncated: false },
    ...overrides,
  } as GitDiffResponse;
}

function previewResponse(preview: Partial<GitFilePreview> = {}) {
  return {
    state: 'ok',
    preview: {
      path: 'notes.txt',
      state: 'ready',
      text: 'hello\n',
      binary: false,
      size: 6,
      truncated: false,
      truncated_bytes: 0,
      ...preview,
    },
  } as GitPreviewResponse;
}

describe('GitWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStatus.mockResolvedValue(statusResponse());
    mockedDiff.mockResolvedValue(diffResponse(''));
    mockedRepository.mockResolvedValue({
      state: 'ok',
      resolution: 'resolved',
      repository: {
        host: 'github.com',
        owner: 'acme',
        repo: 'repo',
        remote_name: 'origin',
        source_url: 'https://github.com/acme/repo',
      },
      branch: 'main',
      choices: [],
      authenticated: true,
    });
  });

  it('keeps local Git functional when the GitHub provider is unavailable (#1290 SC-13)', async () => {
    mockedRepository.mockResolvedValueOnce({
      state: 'error',
      code: 'not_authenticated',
      message: 'no token',
    });
    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-workspace');
    await userEvent.click(screen.getByTestId('git-surface-github'));
    expect(await screen.findByTestId('github-repository-error')).toHaveTextContent(
      'GITHUB_TOKEN',
    );
    await userEvent.click(screen.getByTestId('git-surface-repository'));
    expect(screen.getByTestId('git-workspace')).toBeVisible();
    expect(screen.getByTestId('git-refresh')).toBeInTheDocument();
  });

  it('groups Repository and GitHub without flattening seven peer tabs (#1290)', async () => {
    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-branch');

    expect(screen.getByRole('tab', { name: 'Changes' })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('git-surface-github'));

    await waitFor(() => expect(mockedRepository).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('github-hosting')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Changes' })).toBeNull();

    await userEvent.click(screen.getByTestId('git-surface-repository'));
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeInTheDocument();
    expect(screen.queryByTestId('github-hosting')).toBeNull();
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

  it('groups every status kind and makes every row an opener (#2838)', async () => {
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

    expect(await screen.findByTestId('git-group-changes')).toHaveTextContent('Changes (1)');
    expect(screen.getByTestId('git-group-untracked')).toHaveTextContent('Untracked (1)');

    // Both rows are controls now, but they open different resources: the
    // tracked row has a diff, the untracked row's kind selects a file preview.
    expect(screen.getByTestId('git-row-unstaged')).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByTestId('git-row-untracked')).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
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
              original_path: 'src/b.ts',
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

    const unstaged = screen.getByTestId('git-row-unstaged');
    const staged = screen.getByTestId('git-row-staged');
    // The group heading already says what these rows are; repeating it is
    // decoration. `renamed` is not in the heading, so it stays.
    expect(unstaged).not.toHaveTextContent('modified');
    expect(staged).toHaveTextContent('renamed');
    // The old path cannot fit inline without squeezing the name being read.
    expect(staged).toHaveAttribute('title', 'src/b.ts → src/c.ts');

    // The heading already says untracked, so the row repeats nothing.
    expect(screen.getByTestId('git-row-untracked')).not.toHaveTextContent('untracked');
  });

  it('opens an untracked row as a bounded file preview, not a diff (#2838 SC-01)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [],
          untracked: ['notes.txt'],
          unmerged: [],
        },
      }),
    );
    mockedPreview.mockResolvedValue(previewResponse());

    render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-untracked'));

    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));
    expect(mockedPreview).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      session: 'agent-1:work',
      path: 'notes.txt',
      expected: 'untracked',
      want: 'text',
    });
    expect(mockedDiff).not.toHaveBeenCalled();

    expect(await screen.findByTestId('git-file-preview-status')).toHaveTextContent(
      'Untracked · File preview (no Git baseline)',
    );
    expect(screen.getByTestId('git-file-preview-text')).toHaveTextContent('hello');
    // The row still offers no remote or destructive operation; its write is
    // staging this untracked file, which the contract defines.
    expect(
      screen.queryByRole('button', { name: /push|pull|fetch|checkout|discard|reset/i }),
    ).toBeNull();
  });

  it('opens an unmerged row with its actual worktree bytes (#2838 SC-02)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [],
          untracked: [],
          unmerged: ['both.ts'],
        },
      }),
    );
    mockedPreview.mockResolvedValue(
      previewResponse({
        path: 'both.ts',
        text: '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n',
        size: 44,
      }),
    );

    render(<GitWorkspace ctx={context()} />);
    await expect(screen.findByTestId('git-row-unmerged')).resolves.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('git-row-unmerged'));

    expect(await screen.findByTestId('git-file-preview-status')).toHaveTextContent(
      'Unresolved conflict · File preview',
    );
    expect(screen.getByTestId('git-file-preview-text')).toHaveTextContent('<<<<<<< HEAD');
    expect(screen.getByTestId('git-file-preview-text')).toHaveTextContent('>>>>>>> other');
  });

  it('shows binary, truncation, missing and changed file states truthfully (#2838 SC-02/05)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [],
          untracked: ['assets/logo.bin', 'large.txt', 'gone.txt', 'moved.txt'],
          unmerged: [],
        },
      }),
    );

    render(<GitWorkspace ctx={context()} />);
    const rows = await screen.findAllByTestId('git-row-untracked');

    mockedPreview.mockResolvedValueOnce(
      previewResponse({
        path: 'assets/logo.bin',
        binary: true,
        text: '',
        size: 4096,
      }),
    );
    await userEvent.click(rows[0]);
    expect(await screen.findByTestId('git-file-preview-message')).toHaveTextContent(
      'Binary file — no text preview.',
    );
    expect(screen.getByTestId('git-file-preview-size')).toHaveTextContent('4.0 KB');
    expect(screen.queryByTestId('git-file-preview-text')).toBeNull();

    mockedPreview.mockResolvedValueOnce(
      previewResponse({
        path: 'large.txt',
        text: 'prefix\n',
        size: 4102,
        truncated: true,
        truncated_bytes: 4096,
      }),
    );
    await userEvent.click(rows[1]);
    expect(await screen.findByTestId('git-file-preview-truncated')).toHaveTextContent('4.0 KB');
    expect(screen.getByTestId('git-file-preview-text')).toHaveTextContent('prefix');

    mockedPreview.mockResolvedValueOnce(
      previewResponse({ path: 'gone.txt', state: 'missing', text: '', size: 0 }),
    );
    await userEvent.click(rows[2]);
    expect(await screen.findByTestId('git-file-preview-message')).toHaveTextContent(
      'no longer present',
    );

    mockedPreview.mockResolvedValueOnce(
      previewResponse({
        path: 'moved.txt',
        state: 'changed',
        text: '',
        size: 0,
        message: 'The file changed while it was being read. Refresh Git Changes.',
      }),
    );
    await userEvent.click(rows[3]);
    expect(await screen.findByTestId('git-file-preview-message')).toHaveTextContent(
      'Refresh Git Changes',
    );
  });

  it('drops a stale preview when another file is selected (#2838 SC-05)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [],
          untracked: ['a.txt', 'b.txt'],
          unmerged: [],
        },
      }),
    );
    const resolvers = new Map<string, (value: GitPreviewResponse) => void>();
    mockedPreview.mockImplementation(
      (request) =>
        new Promise<GitPreviewResponse>((resolve) => {
          resolvers.set(request.path, resolve);
        }),
    );

    render(<GitWorkspace ctx={context()} />);
    const rows = await screen.findAllByTestId('git-row-untracked');
    await userEvent.click(rows[0]);
    await userEvent.click(rows[1]);

    await act(async () => {
      resolvers.get('b.txt')?.(previewResponse({ path: 'b.txt', text: 'B\n' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('git-file-preview-text')).toHaveTextContent('B'),
    );

    await act(async () => {
      resolvers.get('a.txt')?.(previewResponse({ path: 'a.txt', text: 'A\n' }));
    });
    expect(screen.getByTestId('git-file-preview-path')).toHaveTextContent('b.txt');
    expect(screen.getByTestId('git-file-preview-text')).toHaveTextContent('B');
    expect(screen.getByTestId('git-file-preview-text')).not.toHaveTextContent('A');
  });

  it('drops an in-flight preview when the Session changes (#2838 SC-05)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [],
          untracked: ['a.txt'],
          unmerged: [],
        },
      }),
    );
    const resolvers: Array<(value: GitPreviewResponse) => void> = [];
    mockedPreview.mockImplementation(
      () =>
        new Promise<GitPreviewResponse>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const { rerender } = render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-untracked'));
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));

    const otherSession: Session = {
      ...session,
      session_id: 'agent-1:other',
      session_name: 'other',
    };
    rerender(<GitWorkspace ctx={context({ session: otherSession })} />);
    await waitFor(() =>
      expect(mockedStatus).toHaveBeenCalledWith({
        agent_id: 'agent-1',
        session: 'agent-1:other',
      }),
    );
    expect(screen.queryByTestId('git-file-preview')).toBeNull();

    await act(async () => {
      resolvers[0]?.(previewResponse({ path: 'a.txt', text: 'previous session\n' }));
    });
    expect(screen.queryByTestId('git-file-preview')).toBeNull();
    expect(screen.queryByText('previous session')).toBeNull();
  });

  it('opens the handed-over path in the mode its status row has (#2838 SC-01)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [],
          untracked: ['notes.txt'],
          unmerged: [],
        },
      }),
    );
    mockedPreview.mockResolvedValue(previewResponse());

    render(
      <GitWorkspace
        ctx={context({ focus: { capabilityId: 'git', resourceId: 'notes.txt' } })}
      />,
    );

    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));
    expect(mockedPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'notes.txt', expected: 'untracked' }),
    );
    expect(await screen.findByTestId('git-file-preview-text')).toHaveTextContent('hello');
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
    const truncatedPatch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    mockedDiff.mockResolvedValue(
      diffResponse(truncatedPatch, {
        diff: {
          path: 'src/a.ts',
          text: truncatedPatch,
          binary: false,
          truncated_bytes: 4096,
          truncated: true,
        },
      } as Partial<GitDiffResponse & { state: 'ok' }>),
    );

    render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-unstaged'));

    await waitFor(() => expect(mockedDiff).toHaveBeenCalledTimes(1));
    expect(mockedDiff).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      session: 'agent-1:work',
      path: 'src/a.ts',
      source: { kind: 'unstaged' },
    });

    const host = await screen.findByTestId('git-diff-patch');
    await waitFor(() => {
      expect(host.querySelector('diffs-container')?.shadowRoot?.textContent).toContain('new');
    });
    expect(screen.getByTestId('git-diff-path')).toHaveTextContent('src/a.ts');

    // C3: a half diff presented as a whole one is the failure this prevents.
    expect(screen.getByTestId('git-diff-truncated')).toHaveTextContent('4.0 KB');
  });

  it('reports the truncation of the listing itself, not just of a diff', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({ truncated: true, truncated_bytes: 2048 }),
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
          truncated_bytes: 0,
          truncated: false,
        },
      } as Partial<GitDiffResponse & { state: 'ok' }>),
    );

    render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-unstaged'));

    expect(await screen.findByTestId('git-diff-binary')).toHaveTextContent('Binary file');
    expect(screen.queryByTestId('git-diff-patch')).toBeNull();
  });

  describe('failure states are readable and distinct (SC4)', () => {
    it('says the Session is not in a repository', async () => {
      mockedStatus.mockResolvedValue({ state: 'not_a_repository', message: 'not a git repository' });

      render(<GitWorkspace ctx={context()} />);

      const panel = await screen.findByTestId('git-unavailable');
      expect(panel).toHaveAttribute('data-state', 'not_a_repository');
      expect(panel).toHaveTextContent(/not in a git repository/i);
    });

    it('says git is missing, which is a different problem with a different fix', async () => {
      mockedStatus.mockResolvedValue({ state: 'unavailable', reason: 'git_not_installed', message: 'git is not installed on this host' });

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

  it('offers exactly the local writes the contract defines, and no others (#845)', async () => {
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

    // Each actionable row carries the write for its own group. The conflicted
    // row is inert: resolving a merge is not a staging action.
    expect(screen.getByRole('button', { name: 'Unstage src/a.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stage src/b.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stage notes.txt' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /stage both\.ts|unstage both\.ts/i }),
    ).toBeNull();

    // The commit control needs a message before it can even open its
    // confirmation; the confirmation itself is what the Case drives.
    expect(screen.getByTestId('git-commit')).toBeDisabled();

    // No remote or history-rewriting operation is expressible anywhere.
    expect(
      screen.queryByRole('button', {
        name: /push|pull|fetch|checkout|switch|discard|reset|rebase|merge/i,
      }),
    ).toBeNull();
  });

  it('stages a reviewed row with the snapshot it was shown, and adopts the answer (#845)', async () => {
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
    mockedStage.mockResolvedValue({
      state: 'ok',
      snapshot: { token: 'token-2', head: 'head-1', root: '/repo' },
      status: {
        branch: 'main',
        detached: false,
        ahead: 0,
        behind: 0,
        modified: [{ path: 'src/a.ts', kind: 'modified', staged: true, unstaged: false }],
        untracked: [],
        unmerged: [],
      },
      truncated: false,
      truncated_bytes: 0,
    });

    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-change-list');

    await userEvent.click(screen.getByRole('button', { name: 'Stage src/a.ts' }));

    await waitFor(() =>
      expect(mockedStage).toHaveBeenCalledWith({
        agent_id: 'agent-1',
        session: 'agent-1:work',
        path: 'src/a.ts',
        expected_snapshot: 'token-1',
      }),
    );
    // The mutation's answer is adopted as the authoritative listing rather
    // than re-read, so the row moves without a second status request.
    await waitFor(() =>
      expect(screen.getByTestId('git-group-staged')).toHaveTextContent('src/a.ts'),
    );
    expect(mockedStatus).toHaveBeenCalledTimes(1);
  });

  it('adopts the current state and explains a stale review instead of applying it (#845)', async () => {
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
    mockedStage.mockResolvedValue({
      state: 'repository_changed',
      message: 'The repository changed after it was reviewed.',
      snapshot: { token: 'token-9', head: 'head-1', root: '/repo' },
      status: {
        branch: 'main',
        detached: false,
        ahead: 0,
        behind: 0,
        modified: [
          { path: 'src/b.ts', kind: 'modified', staged: false, unstaged: true },
        ],
        untracked: [],
        unmerged: [],
      },
      truncated: false,
      truncated_bytes: 0,
    });

    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-change-list');

    await userEvent.click(screen.getByRole('button', { name: 'Stage src/a.ts' }));

    expect(await screen.findByTestId('git-mutation-notice')).toHaveTextContent(
      /repository changed/i,
    );
    // The refusal carries the current state, and the view shows it rather than
    // the stale row the user clicked.
    expect(screen.getByTestId('git-group-changes')).toHaveTextContent('src/b.ts');
    expect(screen.queryByText('src/a.ts')).toBeNull();
  });

  it('commits only after confirmation, with the reviewed snapshot and one request id (#845)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [{ path: 'src/a.ts', kind: 'modified', staged: true, unstaged: false }],
          untracked: [],
          unmerged: [],
        },
      }),
    );
    mockedCreateCommit.mockResolvedValue({
      state: 'ok',
      commit: { oid: 'head-2', author: 'Test <test@example.com>' },
      snapshot: { token: 'token-2', head: 'head-2', root: '/repo' },
      status: {
        branch: 'main',
        detached: false,
        ahead: 0,
        behind: 0,
        modified: [],
        untracked: [],
        unmerged: [],
      },
      truncated: false,
      truncated_bytes: 0,
    });

    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-change-list');

    expect(screen.getByTestId('git-commit')).toBeDisabled();
    await userEvent.type(screen.getByTestId('git-commit-message'), 'feat: change a');
    await userEvent.click(screen.getByTestId('git-commit'));

    // The confirmation is the heavier step a commit is supposed to cost.
    expect(await screen.findByTestId('git-commit-dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('git-commit-confirm'));

    await waitFor(() => expect(mockedCreateCommit).toHaveBeenCalledTimes(1));
    const request = mockedCreateCommit.mock.calls[0][0];
    expect(request).toMatchObject({
      agent_id: 'agent-1',
      session: 'agent-1:work',
      expected_snapshot: 'token-1',
      message: 'feat: change a',
    });
    expect(typeof request.request_id).toBe('string');
    expect(request.request_id.length).toBeGreaterThan(0);

    expect(await screen.findByTestId('git-clean')).toBeInTheDocument();
    expect(screen.queryByTestId('git-commit-form')).toBeNull();
  });

  it('unstages with the reviewed snapshot and never asks for a worktree restore (#845)', async () => {
    mockedStatus.mockResolvedValue(
      statusResponse({
        status: {
          branch: 'main',
          detached: false,
          ahead: 0,
          behind: 0,
          modified: [{ path: 'src/a.ts', kind: 'modified', staged: true, unstaged: false }],
          untracked: [],
          unmerged: [],
        },
      }),
    );
    mockedUnstage.mockResolvedValue({
      state: 'ok',
      snapshot: { token: 'token-2', head: 'head-1', root: '/repo' },
      status: {
        branch: 'main',
        detached: false,
        ahead: 0,
        behind: 0,
        modified: [{ path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true }],
        untracked: [],
        unmerged: [],
      },
      truncated: false,
      truncated_bytes: 0,
    });

    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-change-list');

    await userEvent.click(screen.getByRole('button', { name: 'Unstage src/a.ts' }));

    await waitFor(() =>
      expect(mockedUnstage).toHaveBeenCalledWith({
        agent_id: 'agent-1',
        session: 'agent-1:work',
        path: 'src/a.ts',
        expected_snapshot: 'token-1',
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('git-group-changes')).toHaveTextContent('src/a.ts'),
    );
  });

  it('offers the refresh control to ask again', async () => {
    render(<GitWorkspace ctx={context()} />);
    await screen.findByTestId('git-clean');

    await userEvent.click(screen.getByTestId('git-refresh'));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
  });

  it('keeps Refresh available while a read is in flight (#2787 SC-03)', async () => {
    let resolveFirst!: (value: GitStatusResponse) => void;
    mockedStatus.mockImplementationOnce(
      () =>
        new Promise<GitStatusResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    render(<GitWorkspace ctx={context()} />);
    // The mount read is still in flight, and the manual recovery path is not
    // disabled: the hook, not the button, decides which read is authoritative.
    const refresh = screen.getByTestId('git-refresh');
    expect(refresh).toBeEnabled();
    await userEvent.click(refresh);
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));

    // Let the older mount read finish; the newer answer must remain.
    await act(async () => {
      resolveFirst(statusResponse());
    });
    await waitFor(() =>
      expect(screen.getByTestId('git-summary')).toHaveTextContent('Working tree clean'),
    );
  });

  it('asks for nothing when there is no Session to ask about', async () => {
    render(<GitWorkspace ctx={context({ session: null })} />);

    expect(screen.getByTestId('git-no-session')).toHaveTextContent('Select a Session');
    expect(mockedStatus).not.toHaveBeenCalled();
  });
});

describe('shared presentation and bounded media (#2876)', () => {
  function statusWithUntracked(path: string) {
    return statusResponse({
      status: {
        branch: 'main',
        detached: false,
        ahead: 0,
        behind: 0,
        modified: [],
        untracked: [path],
        unmerged: [],
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedDiff.mockResolvedValue(diffResponse(''));
  });

  it('renders untracked code in the shared CodeMirror source view, not a <pre>', async () => {
    mockedStatus.mockResolvedValue(
      statusWithUntracked('notes/example.ts'),
    );
    mockedPreview.mockResolvedValue(
      previewResponse({ path: 'notes/example.ts', text: 'export const x = 1;\n' }),
    );

    const { container } = render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-untracked'));

    const text = await screen.findByTestId('git-file-preview-text');
    await waitFor(() => expect(text.querySelector('.cm-editor')).not.toBeNull());
    expect(text.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(text.querySelectorAll('pre')).toHaveLength(0);
    expect(text).toHaveTextContent('export const x = 1;');
    expect(screen.getByTestId('git-file-preview-status')).toHaveTextContent(
      'Untracked · File preview (no Git baseline)',
    );
    expect(container.querySelector('[data-testid="file-content-code"]')).not.toBeNull();
  });

  it('offers the shared Preview/Raw leaves for untracked JSON', async () => {
    mockedStatus.mockResolvedValue(
      statusWithUntracked('notes/data.json'),
    );
    mockedPreview.mockResolvedValue(
      previewResponse({
        path: 'notes/data.json',
        text: '{"name":"git-viewer","items":[1,2,3]}',
        size: 34,
      }),
    );

    render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-untracked'));

    expect(await screen.findByRole('tree')).toBeInTheDocument();
    expect(screen.getByText('"name"')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Raw' }));
    const text = screen.getByTestId('git-file-preview-text');
    await waitFor(() => expect(text.querySelector('.cm-editor')).not.toBeNull());
    expect(text).toHaveTextContent('{"name":"git-viewer"');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('tree')).toBeInTheDocument();
  });

  it('renders an authorized untracked image through the shared media viewer', async () => {
    mockedStatus.mockResolvedValue(
      statusWithUntracked('assets/photo.png'),
    );
    mockedPreview.mockResolvedValue(
      previewResponse({
        path: 'assets/photo.png',
        state: 'ready',
        text: '',
        binary: true,
        size: 80,
        media: { content_base64: 'AAAA', mime_type: 'image/png', complete: true },
      }),
    );

    render(<GitWorkspace ctx={context()} />);
    await userEvent.click(await screen.findByTestId('git-row-untracked'));

    expect(await screen.findByTestId('image-viewer')).toBeInTheDocument();
    expect(mockedPreview).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      session: 'agent-1:work',
      path: 'assets/photo.png',
      expected: 'untracked',
      want: 'media',
    });
    expect(screen.queryByTestId('git-file-preview-text')).not.toBeInTheDocument();
  });
});
