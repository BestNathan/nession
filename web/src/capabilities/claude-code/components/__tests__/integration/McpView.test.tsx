import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpPane } from '../../McpView';
import { useMcp } from '../../../hooks/useMcp';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeMcpServers: vi.fn(),
    claudeCodeMcpServer: vi.fn(),
    claudeCodeMcpMutate: vi.fn(),
    claudeCodeMcpConnect: vi.fn(),
  },
}));

vi.mock('@/platform/server', () => ({
  serverApi: { mcpEndpoint: vi.fn() },
}));

const localEntry = {
  name: 'local-tool',
  transport: 'stdio' as const,
  scope: 'local' as const,
  source: '/home/user/.claude.json',
  effective: true,
  read_only: false,
  approval: 'not_required' as const,
  load_state: 'unknown' as const,
  command: 'tool',
  argument_count: 1,
  sanitized_args: ['--token= ***'],
  env_names: ['API_KEY'],
  header_names: [],
  conflict: false,
  fingerprint: 'abc',
};

const userEntry = {
  ...localEntry,
  name: 'user-tool',
  scope: 'user' as const,
  effective: false,
  shadowed_by: 'local' as const,
  read_only: true,
  fingerprint: 'def',
};

const blockedEntry = {
  ...localEntry,
  name: 'personal',
  transport: 'http' as const,
  scope: 'user' as const,
  effective: false,
  read_only: true,
  blocked: 'enterprise_exclusive',
  url: 'https://personal.invalid/mcp',
  command: null,
  argument_count: 0,
  sanitized_args: [],
  env_names: [],
};

const inventory = {
  state: 'ready' as const,
  context: {
    cwd: '/work',
    home: '/home/user',
    config_dir: '/home/user/.claude',
    state_file: '/home/user/.claude.json',
    claude_version: '2.1.325 (Claude Code)',
  },
  sources: [
    {
      id: 'local',
      scope: 'local' as const,
      path: '/home/user/.claude.json',
      state: 'read' as const,
    },
  ],
  servers: [localEntry, userEntry, blockedEntry],
  host: {
    agent: {
      enabled: true,
      url: 'http://127.0.0.1:19091/mcp',
      path: '/mcp',
      token_env_var: 'NESSON_MCP_TOKEN',
    },
    server_configured: true,
  },
};

function Harness() {
  const mcp = useMcp({ agentId: 'a1', sessionId: 'a1:work', active: true });
  return <McpPane mcp={mcp} experience="web" />;
}

describe('MCP view', () => {
  beforeEach(() => {
    vi.mocked(claudeCodeApi.claudeCodeMcpServers).mockReset();
    vi.mocked(claudeCodeApi.claudeCodeMcpServer).mockReset();
    vi.mocked(claudeCodeApi.claudeCodeMcpMutate).mockReset();
    vi.mocked(claudeCodeApi.claudeCodeMcpConnect).mockReset();
    vi.mocked(claudeCodeApi.claudeCodeMcpServers).mockResolvedValue(inventory);
    vi.mocked(claudeCodeApi.claudeCodeMcpServer).mockResolvedValue({
      state: 'ready',
      server: localEntry,
      probe: {
        status: 'not_requested',
        capabilities: [],
        tools: [],
        resources: [],
        prompts: [],
        truncated: false,
      },
    });
  });

  it('lists the Session entries with scope and blocked state', async () => {
    render(<Harness />);

    expect(await screen.findByTestId('claude-code-mcp-row-local-local-tool')).toBeInTheDocument();
    expect(screen.getByTestId('claude-code-mcp-row-user-user-tool')).toBeInTheDocument();
    const blocked = screen.getByTestId('claude-code-mcp-row-user-personal');
    expect(blocked).toHaveTextContent('Blocked by managed policy');
    expect(screen.getByText('3 configured · 1 effective')).toBeInTheDocument();
  });

  it('offers edit/remove only for an editable scope', async () => {
    render(<Harness />);
    const user = await userEvent.setup();
    await user.click(await screen.findByTestId('claude-code-mcp-row-user-user-tool'));
    await screen.findByTestId('claude-code-mcp-detail');
    expect(screen.getByText(/User scope is read-only here/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit user-tool')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('claude-code-mcp-row-local-local-tool'));
    await waitFor(() =>
      expect(screen.getByLabelText('Edit local-tool')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Remove local-tool')).toBeInTheDocument();
  });

  it('asks for stdio consent before launching the discovery process', async () => {
    vi.mocked(claudeCodeApi.claudeCodeMcpServer)
      .mockResolvedValueOnce({
        state: 'ready',
        server: localEntry,
        probe: {
          status: 'not_requested',
          capabilities: [],
          tools: [],
          resources: [],
          prompts: [],
          truncated: false,
        },
      })
      .mockResolvedValueOnce({
        state: 'ready',
        server: localEntry,
        probe: {
          status: 'ok',
          source: 'stdio',
          transport: 'stdio',
          capabilities: ['tools'],
          tools: [
            {
              name: 'read_file',
              description: 'Read one file',
              input_schema: '{"type":"object"}',
            },
          ],
          resources: [],
          prompts: [],
          truncated: false,
        },
      });
    render(<Harness />);
    const user = await userEvent.setup();
    await user.click(await screen.findByTestId('claude-code-mcp-row-local-local-tool'));
    await user.click(await screen.findByTestId('claude-code-mcp-inspect'));

    expect(await screen.findByTestId('claude-code-mcp-stdio-consent')).toBeInTheDocument();
    await user.click(screen.getByTestId('claude-code-mcp-confirm-probe'));

    await waitFor(() =>
      expect(claudeCodeApi.claudeCodeMcpServer).toHaveBeenLastCalledWith(
        expect.objectContaining({ probe: true, allow_stdio: true }),
      ),
    );
    expect(await screen.findByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('Input schema')).toBeInTheDocument();
  });

  it('shows the connect preflight and keeps confirm disabled while blocked', async () => {
    vi.mocked(claudeCodeApi.claudeCodeMcpConnect).mockResolvedValue({
      state: 'blocked',
      preflight: {
        mode: 'agent',
        endpoint_url: 'http://127.0.0.1:19091/mcp',
        credential_env: 'NESSON_MCP_TOKEN',
        credential_present: false,
        credential_verified: false,
        claude_version: '2.1.325',
        ready: false,
        prerequisites: [
          {
            id: 'credential_present',
            label: 'NESSON_MCP_TOKEN is available in this Session environment',
            state: 'missing',
            detail: 'set it through the Session environment binding',
          },
        ],
      },
      reload_required: false,
    });
    render(<Harness />);
    const user = await userEvent.setup();
    await user.click(await screen.findByTestId('claude-code-mcp-connect'));

    expect(await screen.findByTestId('claude-code-mcp-connect-dialog')).toBeInTheDocument();
    expect(
      await screen.findByTestId('claude-code-mcp-prerequisite-credential_present'),
    ).toHaveAttribute('data-state', 'missing');
    expect(screen.getByTestId('claude-code-mcp-confirm-connect')).toBeDisabled();
    expect(screen.getByText(/Connect fails closed/)).toBeInTheDocument();
  });

  it('keeps the manual add form available and scoped to local/project', async () => {
    render(<Harness />);
    const user = await userEvent.setup();
    await user.click(await screen.findByTestId('claude-code-mcp-add'));
    const dialog = await screen.findByTestId('claude-code-mcp-form');
    expect(dialog).toHaveTextContent('Add MCP server');
    expect(screen.getByRole('combobox', { name: /Transport/i })).toBeInTheDocument();
    expect(screen.queryByText(/User scope/i)).not.toBeInTheDocument();
  });
});

describe('MCP view error states', () => {
  it('shows an explicit unavailable state rather than an empty list', async () => {
    vi.mocked(claudeCodeApi.claudeCodeMcpServers).mockResolvedValue({
      state: 'unavailable',
      error: 'session context unavailable: working directory',
      sources: [],
      servers: [],
    });
    render(<Harness />);
    expect(await screen.findByText(/session context unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No MCP servers are configured/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
  });
});
