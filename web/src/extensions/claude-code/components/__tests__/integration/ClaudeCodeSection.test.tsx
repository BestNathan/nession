import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClaudeCodeSection } from '@/extensions/claude-code/components/ClaudeCodeSection';
import { claudeCodeApi } from '@/features/claude-code';
import type { Agent } from '@/types';

vi.mock('@/features/claude-code', () => ({
  claudeCodeApi: {
    claudeCodeList: vi.fn(),
    claudeCodeRead: vi.fn(),
  },
}));

const listResponse = {
  available: true,
  categories: [
    {
      name: 'Settings',
      icon: null,
      files: [{ path: 'settings.json', size: 10, content_type: 'json' }],
    },
  ],
};

const readResponse = {
  content: '{"apiKey":"x"}',
  content_type: 'json',
  total_size: 100,
  offset: 0,
  has_more: false,
};

const mockAgent: Agent = {
  agent_id: 'test-agent-1',
  hostname: 'test-host',
  ip_address: '127.0.0.1',
  port: 19090,
  status: 'online',
  session_count: 3,
  last_heartbeat: new Date().toISOString(),
};

describe('ClaudeCodeSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claudeCodeApi.claudeCodeList).mockResolvedValue({ available: false, categories: [] });
    vi.mocked(claudeCodeApi.claudeCodeRead).mockResolvedValue(readResponse);
  });

  it('renders section header', () => {
    render(<ClaudeCodeSection agent={mockAgent} />);
    expect(screen.getByText('Claude Code')).toBeDefined();
  });

  it('renders loading state initially', () => {
    render(<ClaudeCodeSection agent={mockAgent} />);
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('fetches global config through claudeCodeApi on mount', async () => {
    vi.mocked(claudeCodeApi.claudeCodeList).mockResolvedValue(listResponse);
    render(<ClaudeCodeSection agent={mockAgent} />);
    expect(await screen.findByText('Settings')).toBeDefined();
    expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledWith({
      agent_id: mockAgent.agent_id,
      scope: 'global',
    });
  });

  it('shows the unavailable state when the agent reports no config', async () => {
    render(<ClaudeCodeSection agent={mockAgent} />);
    expect(await screen.findByText('Claude Code not installed')).toBeDefined();
  });

  it('shows the unavailable state with retry when the list reports an error', async () => {
    vi.mocked(claudeCodeApi.claudeCodeList).mockResolvedValue({
      available: false,
      categories: [],
      error: 'agent offline',
    });
    render(<ClaudeCodeSection agent={mockAgent} />);
    expect(await screen.findByText('Configuration unavailable')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('shows the unavailable state with retry when the list request fails', async () => {
    vi.mocked(claudeCodeApi.claudeCodeList).mockRejectedValue(new Error('connection lost'));
    render(<ClaudeCodeSection agent={mockAgent} />);
    expect(await screen.findByText('Configuration unavailable')).toBeDefined();
    expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledTimes(1);
  });

  it('opens the config viewer and loads file content through claudeCodeApi', async () => {
    const user = userEvent.setup();
    vi.mocked(claudeCodeApi.claudeCodeList).mockResolvedValue(listResponse);
    render(<ClaudeCodeSection agent={mockAgent} />);

    await user.click(await screen.findByRole('button', { name: /Settings/ }));
    await user.click(await screen.findByRole('button', { name: 'settings.json' }));

    expect(await screen.findByText('{"apiKey":"x"}')).toBeDefined();
    expect(claudeCodeApi.claudeCodeRead).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: mockAgent.agent_id,
        scope: 'global',
        path: 'settings.json',
        offset: 0,
      }),
    );
    expect(claudeCodeApi.claudeCodeRead).toHaveBeenCalledTimes(1);
  });

  it('retries the fetch when the retry button is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(claudeCodeApi.claudeCodeList)
      .mockResolvedValueOnce({ available: false, categories: [], error: 'agent offline' })
      .mockResolvedValueOnce(listResponse);
    render(<ClaudeCodeSection agent={mockAgent} />);

    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Settings')).toBeDefined();
    expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledTimes(2);
  });
});
