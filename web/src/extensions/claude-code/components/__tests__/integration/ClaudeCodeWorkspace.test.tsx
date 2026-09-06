import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeWorkspace } from '@/extensions/claude-code/components/ClaudeCodeWorkspace';
import { claudeCodeApi } from '@/features/claude-code';
import type {
  ClaudeCodeListResponse,
  ClaudeCodeReadResponse,
} from '@/features/claude-code/types';
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';
import type { Agent, Session } from '@/types';
import type { DomainState } from '@/session-first/domainState';

vi.mock('@/features/claude-code', () => ({
  claudeCodeApi: {
    claudeCodeList: vi.fn(),
    claudeCodeRead: vi.fn(),
  },
}));

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

const globalResponse: ClaudeCodeListResponse = {
  available: true,
  categories: [
    {
      name: 'Settings',
      icon: null,
      files: [{ path: 'settings.json', size: 2_097_152, content_type: 'json' }],
    },
  ],
};

const projectResponse: ClaudeCodeListResponse = {
  available: true,
  categories: [
    {
      name: 'Instructions',
      icon: null,
      files: [{ path: 'CLAUDE.md', size: 12, content_type: 'markdown' }],
    },
  ],
};

const readResponse: ClaudeCodeReadResponse = {
  content: '{"enabled":true}',
  content_type: 'json',
  total_size: 2_097_152,
  offset: 0,
  has_more: true,
};

const twoFileGlobalResponse: ClaudeCodeListResponse = {
  ...globalResponse,
  categories: [
    {
      name: 'Settings',
      icon: null,
      files: [
        { path: 'a.json', size: 4, content_type: 'json' },
        { path: 'b.json', size: 4, content_type: 'json' },
      ],
    },
  ],
};

function makeContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    session,
    agent,
    domain,
    fileOps: null,
    experience: 'web',
    onToolChange: vi.fn(),
    ...overrides,
  };
}

function mockLists(
  global: ClaudeCodeListResponse = globalResponse,
  project: ClaudeCodeListResponse = projectResponse,
) {
  vi.mocked(claudeCodeApi.claudeCodeList)
    .mockResolvedValueOnce(global)
    .mockResolvedValueOnce(project);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ClaudeCodeWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claudeCodeApi.claudeCodeList).mockReset();
    vi.mocked(claudeCodeApi.claudeCodeRead).mockReset();
  });

  it('requests both scopes and renders the global file browser', async () => {
    const user = userEvent.setup();
    const globalList = deferred<ClaudeCodeListResponse>();
    const projectList = deferred<ClaudeCodeListResponse>();
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockReturnValueOnce(globalList.promise)
      .mockReturnValueOnce(projectList.promise);
    vi.mocked(claudeCodeApi.claudeCodeRead).mockResolvedValue(readResponse);
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    expect(screen.getByTestId('claude-code-workspace')).toBeInTheDocument();
    expect(screen.getAllByText('Loading Claude Code files...')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Global' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByTestId('claude-code-scope-global')).toBeInTheDocument();
    expect(screen.getByTestId('claude-code-scope-project')).toBeInTheDocument();

    await waitFor(() => {
      expect(claudeCodeApi.claudeCodeList).toHaveBeenNthCalledWith(1, {
        agent_id: 'agent-1',
        scope: 'global',
      });
      expect(claudeCodeApi.claudeCodeList).toHaveBeenNthCalledWith(2, {
        agent_id: 'agent-1',
        scope: 'project',
        session_id: 'agent-1:work',
      });
    });
    globalList.resolve(globalResponse);
    projectList.resolve(projectResponse);
    const fileButton = await screen.findByRole('button', { name: 'settings.json' });
    expect(fileButton).not.toHaveAttribute('aria-current');
    await user.click(fileButton);
    expect(fileButton).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByText('{"enabled":true}')).toBeInTheDocument();
    expect(claudeCodeApi.claudeCodeRead).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      scope: 'global',
      path: 'settings.json',
      offset: 0,
    });
    expect(screen.getByText(/2\.0 MB/)).toBeInTheDocument();
  });

  it('shows scope-local project files and reads project files with a session id', async () => {
    const user = userEvent.setup();
    mockLists();
    vi.mocked(claudeCodeApi.claudeCodeRead).mockResolvedValue({
      ...readResponse,
      content: '# Project instructions',
      content_type: 'markdown',
      total_size: 12,
      has_more: false,
    });
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    await user.click(screen.getByRole('tab', { name: 'Project' }));
    const projectScope = screen.getByTestId('claude-code-scope-project');
    await user.click(await within(projectScope).findByRole('button', { name: 'CLAUDE.md' }));

    expect(await screen.findByText('# Project instructions')).toBeInTheDocument();
    expect(claudeCodeApi.claudeCodeRead).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      scope: 'project',
      session_id: 'agent-1:work',
      path: 'CLAUDE.md',
      offset: 0,
    });
    expect(screen.getByText(/markdown/)).toBeInTheDocument();
    expect(within(screen.getByTestId('claude-code-scope-project')).getByTestId('claude-code-file-list')).toBeInTheDocument();
  });

  it('loads more content at the current content length and appends it', async () => {
    const user = userEvent.setup();
    mockLists();
    vi.mocked(claudeCodeApi.claudeCodeRead)
      .mockResolvedValueOnce(readResponse)
      .mockResolvedValueOnce({
        ...readResponse,
        content: '\ncontinued',
        offset: readResponse.content.length,
        has_more: false,
      });
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    await user.click(await screen.findByRole('button', { name: 'settings.json' }));
    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(screen.getByTestId('claude-code-content').textContent).toBe('{"enabled":true}\ncontinued');
    expect(claudeCodeApi.claudeCodeRead).toHaveBeenNthCalledWith(2, {
      agent_id: 'agent-1',
      scope: 'global',
      path: 'settings.json',
      offset: readResponse.content.length,
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('uses UTF-8 byte offsets when loading more multibyte content', async () => {
    const user = userEvent.setup();
    mockLists();
    vi.mocked(claudeCodeApi.claudeCodeRead)
      .mockResolvedValueOnce({
        ...readResponse,
        content: '你好',
        total_size: 9,
        has_more: true,
      })
      .mockResolvedValueOnce({
        ...readResponse,
        content: '世界',
        offset: 6,
        total_size: 12,
        has_more: false,
      });
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    await user.click(await screen.findByRole('button', { name: 'settings.json' }));
    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(screen.getByTestId('claude-code-content').textContent).toBe('你好世界');
    expect(claudeCodeApi.claudeCodeRead).toHaveBeenNthCalledWith(2, {
      agent_id: 'agent-1',
      scope: 'global',
      path: 'settings.json',
      offset: 6,
    });
  });

  it('preserves existing content and Load more when pagination fails', async () => {
    const user = userEvent.setup();
    mockLists();
    vi.mocked(claudeCodeApi.claudeCodeRead)
      .mockResolvedValueOnce(readResponse)
      .mockRejectedValueOnce(new Error('pagination failed'));
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    await user.click(await screen.findByRole('button', { name: 'settings.json' }));
    await screen.findByText('{"enabled":true}');
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('pagination failed')).toBeInTheDocument();
    expect(screen.getByTestId('claude-code-content').textContent).toBe('{"enabled":true}');
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('ignores a late read response when a newer file selection completes first', async () => {
    const user = userEvent.setup();
    let resolveA: (response: ClaudeCodeReadResponse) => void = () => undefined;
    let resolveB: (response: ClaudeCodeReadResponse) => void = () => undefined;
    const readA = new Promise<ClaudeCodeReadResponse>((resolve) => { resolveA = resolve; });
    const readB = new Promise<ClaudeCodeReadResponse>((resolve) => { resolveB = resolve; });
    mockLists(twoFileGlobalResponse, projectResponse);
    vi.mocked(claudeCodeApi.claudeCodeRead)
      .mockReturnValueOnce(readA)
      .mockReturnValueOnce(readB);
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    await user.click(await screen.findByRole('button', { name: 'a.json' }));
    await user.click(screen.getByRole('button', { name: 'b.json' }));
    resolveB({ ...readResponse, content: 'content from B', has_more: false });
    expect(await screen.findByText('content from B')).toBeInTheDocument();
    resolveA({ ...readResponse, content: 'late content from A', has_more: false });

    await waitFor(() => {
      expect(screen.getByTestId('claude-code-content').textContent).toBe('content from B');
    });
    expect(screen.queryByText('late content from A')).not.toBeInTheDocument();
  });

  it('keeps the file list when reading fails and shows an inline error', async () => {
    const user = userEvent.setup();
    mockLists();
    vi.mocked(claudeCodeApi.claudeCodeRead).mockRejectedValue(new Error('read failed'));
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    await user.click(await screen.findByRole('button', { name: 'settings.json' }));

    expect(await screen.findByText('read failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.json' })).toBeInTheDocument();
    expect(within(screen.getByTestId('claude-code-scope-global')).getByTestId('claude-code-file-list')).toBeInTheDocument();
  });

  it('keeps list failures independent and retries each scope locally', async () => {
    const user = userEvent.setup();
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockRejectedValueOnce(new Error('global failed'))
      .mockResolvedValueOnce(projectResponse)
      .mockResolvedValueOnce(globalResponse);
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    expect(await screen.findByText('global failed')).toBeInTheDocument();
    expect(screen.getByTestId('claude-code-retry-global')).toBeInTheDocument();
    expect(screen.queryByText('global failed', { selector: '[data-scope="project"]' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Project' }));
    expect(await within(screen.getByTestId('claude-code-scope-project')).findByRole('button', { name: 'CLAUDE.md' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Global' }));
    await user.click(screen.getByTestId('claude-code-retry-global'));
    expect(await screen.findByRole('button', { name: 'settings.json' })).toBeInTheDocument();
    expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledTimes(3);
  });

  it('shows the not-installed state for an unavailable scope', async () => {
    mockLists({ available: false, categories: [] }, projectResponse);
    render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    expect(await within(screen.getByTestId('claude-code-scope-global')).findByText('Claude Code not installed')).toBeInTheDocument();
  });

  it('does not request without an agent or session and explains the missing context', () => {
    render(<ClaudeCodeWorkspace ctx={makeContext({ agent: undefined })} />);

    expect(screen.getByText('Select an agent and session to browse Claude Code files.')).toBeInTheDocument();
    expect(claudeCodeApi.claudeCodeList).not.toHaveBeenCalled();
  });

  it('does not request without a session when the agent is present', () => {
    render(<ClaudeCodeWorkspace ctx={makeContext({ session: null })} />);

    expect(screen.getByText('Select an agent and session to browse Claude Code files.')).toBeInTheDocument();
    expect(claudeCodeApi.claudeCodeList).not.toHaveBeenCalled();
  });

  it('resets scope and selection when the agent or session changes', async () => {
    const user = userEvent.setup();
    mockLists();
    vi.mocked(claudeCodeApi.claudeCodeRead).mockResolvedValue({ ...readResponse, has_more: false });
    const { rerender } = render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    await user.click(await screen.findByRole('button', { name: 'settings.json' }));
    expect(await screen.findByText('{"enabled":true}')).toBeInTheDocument();

    const nextSession: Session = { ...session, session_id: 'agent-1:review', session_name: 'review' };
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockResolvedValueOnce(projectResponse)
      .mockResolvedValueOnce(globalResponse);
    rerender(<ClaudeCodeWorkspace ctx={makeContext({ session: nextSession })} />);

    await waitFor(() => {
      expect(screen.queryByText('{"enabled":true}')).not.toBeInTheDocument();
      expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledWith({
        agent_id: 'agent-1',
        scope: 'project',
        session_id: 'agent-1:review',
      });
    });
    expect(screen.getByRole('tab', { name: 'Global' })).toHaveAttribute('aria-selected', 'true');
  });

  it('ignores a stale list response from the previous agent and session', async () => {
    let resolveOldGlobal: (response: ClaudeCodeListResponse) => void = () => undefined;
    const oldGlobal = new Promise<ClaudeCodeListResponse>((resolve) => {
      resolveOldGlobal = resolve;
    });
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockReturnValueOnce(oldGlobal)
      .mockResolvedValueOnce(projectResponse);
    const { rerender } = render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    const nextAgent: Agent = { ...agent, agent_id: 'agent-2' };
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockResolvedValueOnce({ ...globalResponse, categories: [] })
      .mockResolvedValueOnce({ ...projectResponse, categories: [] });
    rerender(<ClaudeCodeWorkspace ctx={makeContext({ agent: nextAgent })} />);
    resolveOldGlobal(globalResponse);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'settings.json' })).not.toBeInTheDocument();
      expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledWith({
        agent_id: 'agent-2',
        scope: 'global',
      });
    });
  });

  it('ignores stale list responses when only the session changes', async () => {
    const oldGlobal = deferred<ClaudeCodeListResponse>();
    const oldProject = deferred<ClaudeCodeListResponse>();
    const oldGlobalResponse: ClaudeCodeListResponse = {
      ...globalResponse,
      categories: [{
        ...globalResponse.categories[0],
        files: [{ path: 'old-global.json', size: 1, content_type: 'json' }],
      }],
    };
    const oldProjectResponse: ClaudeCodeListResponse = {
      ...projectResponse,
      categories: [{
        ...projectResponse.categories[0],
        files: [{ path: 'old-project.md', size: 1, content_type: 'markdown' }],
      }],
    };
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockReturnValueOnce(oldGlobal.promise)
      .mockReturnValueOnce(oldProject.promise);
    const { rerender } = render(<ClaudeCodeWorkspace ctx={makeContext()} />);

    const nextSession: Session = { ...session, session_id: 'agent-1:review', session_name: 'review' };
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockResolvedValueOnce(globalResponse)
      .mockResolvedValueOnce(projectResponse);
    rerender(<ClaudeCodeWorkspace ctx={makeContext({ session: nextSession })} />);
    oldGlobal.resolve(oldGlobalResponse);
    oldProject.resolve(oldProjectResponse);

    expect(await screen.findByRole('button', { name: 'settings.json' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'old-global.json' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'old-project.md' })).not.toBeInTheDocument();
    expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      scope: 'project',
      session_id: 'agent-1:review',
    });
  });
});
