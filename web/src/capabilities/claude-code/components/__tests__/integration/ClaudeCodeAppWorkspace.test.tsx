import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAppWorkspace } from '../../ClaudeCodeAppWorkspace';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type {
  ClaudeCodeConversationsResponse,
  ClaudeCodeListResponse,
  ClaudeCodeMcpServersResponse,
  ClaudeCodeMemoryResponse,
  ClaudeCodeReadResponse,
  ClaudeCodeTranscriptRecordsResponse,
  ClaudeCodeTranscriptsResponse,
} from '../../../types';
import type {
  WorkspaceContext,
  WorkspaceHeaderAction,
  WorkspacePush,
} from '@/app/workspace/workspaceContext';
import type { Agent, Session } from '@/types';
import type { DomainState } from '@/product/session/model/domainState';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeList: vi.fn(),
    claudeCodeRead: vi.fn(),
    claudeCodeConversations: vi.fn(),
    claudeCodeMessages: vi.fn(),
    claudeCodeTranscripts: vi.fn(),
    claudeCodeTranscriptRecords: vi.fn(),
    claudeCodeTranscriptRecord: vi.fn(),
    claudeCodeMemory: vi.fn(),
    claudeCodeMemoryRead: vi.fn(),
    claudeCodeMcpServers: vi.fn(),
    claudeCodeMcpServer: vi.fn(),
    claudeCodeMcpMutate: vi.fn(),
    claudeCodeMcpConnect: vi.fn(),
  },
}));

vi.mock('@/platform/server', () => ({
  serverApi: { mcpEndpoint: vi.fn() },
}));

const agent: Agent = {
  agent_id: 'agent-1',
  hostname: 'workstation',
  ip_address: '127.0.0.1',
  port: 19090,
  status: 'online',
  session_count: 1,
  last_heartbeat: '2026-11-18T00:00:00.000Z',
};

const session: Session = {
  session_id: 'agent-1:work',
  agent_id: 'agent-1',
  session_name: 'work',
  status: 'active',
  window_count: 1,
  attached_clients: 1,
  last_activity: '2026-11-18T00:00:00.000Z',
};

const domain: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};

const currentConversation = {
  id: 'c1',
  cwd: '/work',
  title: 'Current work',
  preview: 'ship the redesign',
  updated_at: '2026-11-18T10:00:00.000Z',
};

const olderConversation = {
  id: 'c2',
  cwd: '/work',
  title: 'Older work',
  preview: 'another thread',
  updated_at: '2026-11-17T10:00:00.000Z',
};

const conversations: ClaudeCodeConversationsResponse = {
  state: 'ready',
  items: [currentConversation, olderConversation],
  binding: { conversation_id: 'c1', activity: 'inactive' },
  has_more: false,
};

const transcriptItem = {
  id: 't1',
  cwd: '/work',
  kind: 'primary' as const,
  parent_id: null,
  agent_id: null,
  title: 'Focused transcript',
  preview: null,
  created_at: '2026-11-18T09:00:00.000Z',
  updated_at: '2026-11-18T10:00:00.000Z',
};

const transcripts: ClaudeCodeTranscriptsResponse = {
  state: 'ready',
  items: [transcriptItem],
  binding: null,
  has_more: false,
};

const validRecordRaw = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'the readable answer' }],
  },
});

const transcriptRecords: ClaudeCodeTranscriptRecordsResponse = {
  state: 'ready',
  transcript: transcriptItem,
  activity: 'inactive',
  records: [
    {
      record_ref: 'r1',
      offset: 0,
      size_bytes: validRecordRaw.length,
      raw: validRecordRaw,
    },
    {
      record_ref: 'r2',
      offset: 128,
      size_bytes: 14,
      raw: 'not json at all',
    },
  ],
  has_more: false,
  partial_tail: false,
};

const memoryResponse: ClaudeCodeMemoryResponse = {
  state: 'ready',
  repository_root: '/work',
  repository_kind: 'git',
  memory_directory: '/home/user/.claude/projects/-work/memory',
  files: [
    { path: 'MEMORY.md', size: 7, content_type: 'markdown' },
    { path: 'architecture.md', size: 9, content_type: 'markdown' },
  ],
  truncated: false,
};

const projectList: ClaudeCodeListResponse = {
  available: true,
  categories: [
    {
      name: 'Instructions',
      icon: null,
      files: [{ path: 'CLAUDE.md', size: 12, content_type: 'markdown' }],
    },
  ],
};

const globalList: ClaudeCodeListResponse = {
  available: true,
  categories: [
    {
      name: 'Settings',
      icon: null,
      files: [{ path: 'settings.json', size: 20, content_type: 'json' }],
    },
  ],
};

const readResponse: ClaudeCodeReadResponse = {
  content: '# guidance',
  content_type: 'markdown',
  total_size: 10,
  offset: 0,
  has_more: false,
};

const mcpTool = {
  name: 'session.list',
  description: 'List sessions',
  input_schema: '{"type":"object"}',
};

const mcpServer = {
  name: 'local-tool',
  transport: 'http' as const,
  scope: 'local' as const,
  source: '/home/user/.claude.json',
  effective: true,
  read_only: false,
  approval: 'not_required' as const,
  load_state: 'unknown' as const,
  url: 'http://127.0.0.1:19091/mcp',
  argument_count: 0,
  sanitized_args: [],
  env_names: [],
  header_names: [],
  conflict: false,
};

const mcpServers: ClaudeCodeMcpServersResponse = {
  state: 'ready',
  context: {
    cwd: '/work',
    home: '/home/user',
    config_dir: '/home/user/.claude',
    state_file: '/home/user/.claude.json',
    claude_version: '2.1.325 (Claude Code)',
  },
  sources: [
    { id: 'local', scope: 'local', path: '/home/user/.claude.json', state: 'read' },
  ],
  servers: [mcpServer],
  host: {
    agent: { enabled: true, url: 'http://127.0.0.1:19091/mcp', path: '/mcp', token_env_var: 'NESSION_MCP_TOKEN' },
    server_configured: true,
  },
};

function makeContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    session,
    agent,
    agents: [agent],
    domain,
    fileOps: null,
    experience: 'app',
    onToolChange: vi.fn(),
    ...overrides,
  };
}

function lastPush(setPush: ReturnType<typeof vi.fn>): WorkspacePush | null {
  const calls = setPush.mock.calls;
  return calls.length === 0 ? null : (calls[calls.length - 1][0] as WorkspacePush | null);
}

function lastAction(setActions: ReturnType<typeof vi.fn>): WorkspaceHeaderAction | null {
  const calls = setActions.mock.calls;
  const actions = calls.length === 0 ? null : (calls[calls.length - 1][0] as readonly WorkspaceHeaderAction[] | null);
  return actions?.[0] ?? null;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function layer(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

function renderApp(ctx: WorkspaceContext = makeContext()) {
  const setPush = vi.fn<(push: WorkspacePush | null) => void>();
  const setActions = vi.fn<(actions: readonly WorkspaceHeaderAction[] | null) => void>();
  const view = render(
    <ClaudeCodeAppWorkspace ctx={ctx} depth={{ setPush, setActions }} />,
  );
  return { ...view, setPush, setActions };
}

async function openBrowse(setActions: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(lastAction(setActions)).not.toBeNull());
  act(() => {
    lastAction(setActions)?.onActivate();
  });
}

async function chooseBrowse(testId: string) {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(testId));
}

describe('Claude App workspace (#3829)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claudeCodeApi.claudeCodeConversations).mockResolvedValue(conversations);
    vi.mocked(claudeCodeApi.claudeCodeMessages).mockImplementation(async (request) => ({
      state: 'ready',
      conversation:
        request.conversation_id === 'c2' ? olderConversation : currentConversation,
      activity: 'inactive',
      items: [
        {
          kind: 'message',
          id: `m-${request.conversation_id}`,
          role: 'user',
          content: [{ type: 'text', text: `hello from ${request.conversation_id}` }],
        },
      ],
      has_more: false,
      partial_tail: false,
      skipped: 0,
    }));
    vi.mocked(claudeCodeApi.claudeCodeTranscripts).mockResolvedValue(transcripts);
    vi.mocked(claudeCodeApi.claudeCodeTranscriptRecords).mockResolvedValue(transcriptRecords);
    vi.mocked(claudeCodeApi.claudeCodeTranscriptRecord).mockResolvedValue({
      state: 'ready',
      record_ref: 'r2',
      raw: 'not json at all',
      offset: 0,
      size_bytes: 14,
      has_more: false,
    });
    vi.mocked(claudeCodeApi.claudeCodeMemory).mockResolvedValue(memoryResponse);
    vi.mocked(claudeCodeApi.claudeCodeMemoryRead).mockResolvedValue({
      content: '# Memory index',
      content_type: 'markdown',
      total_size: 14,
      offset: 0,
      has_more: false,
    });
    vi.mocked(claudeCodeApi.claudeCodeList).mockReset();
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockResolvedValueOnce(globalList)
      .mockResolvedValueOnce(projectList)
      .mockResolvedValue(projectList);
    vi.mocked(claudeCodeApi.claudeCodeRead).mockResolvedValue(readResponse);
    vi.mocked(claudeCodeApi.claudeCodeMcpServers).mockResolvedValue(mcpServers);
    vi.mocked(claudeCodeApi.claudeCodeMcpServer).mockResolvedValue({
      state: 'ready',
      server: mcpServer,
      probe: {
        status: 'ok',
        capabilities: ['tools'],
        tools: [mcpTool],
        resources: [],
        prompts: [],
        truncated: false,
      },
    });
  });

  it('opens on the bound conversation and declares Browse as the one contextual action', async () => {
    const { setPush, setActions } = renderApp();

    expect(await screen.findByText('Current work')).toBeInTheDocument();
    expect(screen.getByTestId('claude-app-root')).not.toHaveAttribute('data-covered');
    // No five-tab strip and no Web heading: the shell header names the page.
    expect(screen.queryByTestId('claude-code-view-tabs')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByText('Read-only view. Continue this conversation in the Terminal.')).toBeInTheDocument();

    await waitFor(() => expect(lastAction(setActions)).not.toBeNull());
    expect(lastAction(setActions)).toMatchObject({
      id: 'browse',
      label: 'Browse',
      ariaLabel: 'Browse Claude',
      icon: 'browse',
    });
    expect(lastPush(setPush)).toBeNull();
  });

  it('reads a directory conversation without replacing the bound root, and Back restores it', async () => {
    const { setPush, setActions } = renderApp();
    await screen.findByText('Current work');
    await openBrowse(setActions);
    await chooseBrowse('claude-browse-conversations');

    expect(lastPush(setPush)?.title).toBe('Conversations');
    expect(lastPush(setPush)?.backLabel).toBe('Back to Claude Code');
    const conversationsLayer = layer('claude-app-layer-conversations');
    expect(within(conversationsLayer).getByText('Current work')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(conversationsLayer).getByTitle('c2'));

    expect(lastPush(setPush)?.title).toBe('Older work');
    expect(lastPush(setPush)?.backLabel).toBe('Back to Conversations');
    const detail = layer('claude-app-layer-conversation');
    expect(await within(detail).findByText('hello from c2')).toBeInTheDocument();
    expect(within(detail).getByText(/not bound to this Session/)).toBeInTheDocument();
    expect(
      within(detail).queryByText('hello from c1'),
    ).toBeNull();

    // Back once returns to the list; the bound root was never disturbed.
    act(() => {
      lastPush(setPush)?.onLeave();
    });
    expect(layer('claude-app-layer-conversations')).not.toHaveAttribute('data-covered');
    act(() => {
      lastPush(setPush)?.onLeave();
    });
    expect(screen.getByTestId('claude-app-root')).not.toHaveAttribute('data-covered');
    expect(lastPush(setPush)).toBeNull();
    expect(screen.getByText('Current work')).toBeInTheDocument();
    expect(screen.queryByText('hello from c2')).toBeNull();
  });

  it('does not claim an unbound candidate as the current conversation', async () => {
    vi.mocked(claudeCodeApi.claudeCodeConversations).mockResolvedValue({
      ...conversations,
      binding: undefined,
    });
    const { setPush, setActions } = renderApp();

    expect(await screen.findByTestId('claude-app-unbound')).toBeInTheDocument();
    expect(screen.getByText('No conversation linked to this Session')).toBeInTheDocument();
    expect(claudeCodeApi.claudeCodeMessages).not.toHaveBeenCalled();

    await openBrowse(setActions);
    await chooseBrowse('claude-browse-conversations');
    const listLayer = layer('claude-app-layer-conversations');
    await userEvent.click(within(listLayer).getByTitle('c2'));
    expect(await screen.findByText('hello from c2')).toBeInTheDocument();
    expect(screen.getByText(/not bound to this Session/)).toBeInTheDocument();
    expect(lastPush(setPush)?.title).toBe('Older work');
  });

  it('shows the directory loading state instead of claiming no binding', async () => {
    const pending = deferred<ClaudeCodeConversationsResponse>();
    vi.mocked(claudeCodeApi.claudeCodeConversations).mockReturnValueOnce(pending.promise);
    renderApp();

    expect(await screen.findByTestId('conversation-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-app-unbound')).toBeNull();

    pending.resolve(conversations);
    expect(await screen.findByText('Current work')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-app-unbound')).toBeNull();
  });

  it('pushes every transcript record, and Raw from a malformed record stays readable', async () => {
    const { setPush, setActions } = renderApp();
    await screen.findByText('Current work');
    await openBrowse(setActions);
    await chooseBrowse('claude-browse-transcripts');

    expect(lastPush(setPush)?.title).toBe('Transcripts');
    const listLayer = layer('claude-app-layer-transcripts');
    await userEvent.click(within(listLayer).getByTestId('transcript-open'));

    expect(lastPush(setPush)?.title).toBe('Focused transcript');
    const transcriptLayer = layer('claude-app-layer-transcript');
    expect(await within(transcriptLayer).findAllByTestId('transcript-record')).toHaveLength(2);

    // The first row's native detail is its own pushed depth.
    await userEvent.click(within(transcriptLayer).getAllByTestId('transcript-record-open')[0]);
    expect(lastPush(setPush)?.title).toBe('Claude');
    const recordLayer = layer('claude-app-layer-record');
    expect(await within(recordLayer).findByTestId('transcript-record-detail')).toBeInTheDocument();

    // Raw is a further depth, and Back returns to the record.
    await userEvent.click(within(recordLayer).getByTestId('claude-app-record-raw'));
    expect(lastPush(setPush)?.title).toBe('Raw record');
    const rawLayer = layer('claude-app-layer-raw');
    expect(within(rawLayer).getByTestId('transcript-raw-inspector')).toHaveAttribute(
      'data-variant',
      'pushed',
    );
    act(() => {
      lastPush(setPush)?.onLeave();
    });
    expect(layer('claude-app-layer-record')).not.toHaveAttribute('data-covered');

    // A malformed record's Raw is reachable straight from the row, and its
    // original source is shown because there is no JSON tree to offer.
    act(() => {
      lastPush(setPush)?.onLeave();
    });
    const liveTranscript = layer('claude-app-layer-transcript');
    await userEvent.click(within(liveTranscript).getAllByTestId('transcript-raw-open')[1]);
    const malformedRaw = layer('claude-app-layer-raw');
    expect(await within(malformedRaw).findByTestId('transcript-raw-text')).toHaveTextContent(
      'not json at all',
    );
  });

  it('pushes a memory file and restores the list selection', async () => {
    const { setPush, setActions } = renderApp();
    await screen.findByText('Current work');
    await openBrowse(setActions);
    await chooseBrowse('claude-browse-memory');

    const memoryLayer = layer('claude-app-layer-memory');
    expect(await within(memoryLayer).findByTestId('claude-code-memory-list')).toBeInTheDocument();
    await userEvent.click(within(memoryLayer).getByLabelText('architecture.md'));

    expect(lastPush(setPush)?.title).toBe('Memory file');
    const fileLayer = layer('claude-app-layer-memory-file');
    expect(await within(fileLayer).findByTestId('claude-code-memory-content')).toHaveTextContent(
      'Memory index',
    );

    act(() => {
      lastPush(setPush)?.onLeave();
    });
    expect(layer('claude-app-layer-memory')).not.toHaveAttribute('data-covered');
  });

  it('pushes Configuration files as one column and keeps the scope inside it', async () => {
    const { setPush, setActions } = renderApp();
    await screen.findByText('Current work');
    await openBrowse(setActions);
    await chooseBrowse('claude-browse-configuration');

    const configuration = layer('claude-app-layer-configuration');
    expect(await within(configuration).findByTestId('claude-code-scope-project')).toBeInTheDocument();
    await userEvent.click(within(configuration).getByTestId('claude-app-configuration-global'));
    expect(within(configuration).getByTestId('claude-code-scope-global')).toBeInTheDocument();
    await userEvent.click(within(configuration).getByTestId('claude-app-configuration-project'));

    await userEvent.click(await within(configuration).findByLabelText('CLAUDE.md'));
    expect(lastPush(setPush)?.title).toBe('CLAUDE.md');
    const fileLayer = layer('claude-app-layer-config-file');
    expect(await within(fileLayer).findByTestId('claude-code-content')).toHaveTextContent(
      '# guidance',
    );
  });

  it('pushes an MCP server and its inspected tool schema, with no second Back', async () => {
    const { setPush, setActions } = renderApp();
    await screen.findByText('Current work');
    await openBrowse(setActions);
    await chooseBrowse('claude-browse-mcp');

    const mcpLayer = layer('claude-app-layer-mcp');
    await userEvent.click(
      await within(mcpLayer).findByTestId('claude-code-mcp-row-local-local-tool'),
    );
    expect(lastPush(setPush)?.title).toBe('local-tool');

    const serverLayer = layer('claude-app-layer-mcp-server');
    expect(await within(serverLayer).findByTestId('claude-code-mcp-detail')).toBeInTheDocument();
    // The shell header owns the one leave; the capability's inline Back is gone.
    expect(within(serverLayer).queryByTestId('claude-code-mcp-back')).toBeNull();

    // Inspection is explicit: the tool list arrives only after Inspect tools.
    await userEvent.click(within(serverLayer).getByTestId('claude-code-mcp-inspect'));
    await userEvent.click(await within(serverLayer).findByTestId('claude-code-mcp-tool-open'));
    expect(lastPush(setPush)?.title).toBe('session.list');
    const toolLayer = layer('claude-app-layer-mcp-tool');
    expect(within(toolLayer).getByText('session.list')).toBeInTheDocument();
    expect(within(toolLayer).getByText(/"type": "object"/)).toBeInTheDocument();
  });

  it('retires a pushed depth when the Session changes', async () => {
    const { setPush, setActions, rerender } = renderApp();
    await screen.findByText('Current work');
    await openBrowse(setActions);
    await chooseBrowse('claude-browse-configuration');
    expect(lastPush(setPush)?.title).toBe('Configuration');

    vi.mocked(claudeCodeApi.claudeCodeConversations).mockResolvedValue(conversations);
    rerender(
      <ClaudeCodeAppWorkspace
        ctx={makeContext({
          session: { ...session, session_id: 'agent-1:other', session_name: 'other' },
        })}
        depth={{ setPush, setActions }}
      />,
    );

    await waitFor(() => expect(lastPush(setPush)).toBeNull());
    expect(screen.getByTestId('claude-app-root')).not.toHaveAttribute('data-covered');
    await waitFor(() =>
      expect(lastAction(setActions)).toMatchObject({ id: 'browse', label: 'Browse' }),
    );
  });

  it('never labels a foreground Claude process as working activity', async () => {
    const { setActions } = renderApp(
      makeContext({ facts: { sessionForegroundCommand: 'claude' } }),
    );
    await screen.findByText('Current work');
    await openBrowse(setActions);
    await chooseBrowse('claude-browse-conversations');

    // The provider's own word for the bound conversation is `inactive`, so the
    // view may say so — but the observation that a shell is running `claude`
    // must not become a work claim.
    expect(screen.getByTestId('conversation-state')).toHaveTextContent('Finished');
    expect(screen.queryByText('Working')).toBeNull();
    expect(screen.queryByText('Running now')).toBeNull();
  });
});
