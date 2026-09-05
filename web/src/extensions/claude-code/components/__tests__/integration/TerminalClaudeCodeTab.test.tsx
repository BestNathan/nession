import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalClaudeCodeTab } from '@/extensions/claude-code/components/TerminalClaudeCodeTab';
import { claudeCodeApi } from '@/features/claude-code';

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

const sessionId = 'test-agent-1:work';

describe('TerminalClaudeCodeTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claudeCodeApi.claudeCodeList).mockResolvedValue({ available: false, categories: [] });
    vi.mocked(claudeCodeApi.claudeCodeRead).mockResolvedValue(readResponse);
  });

  it('renders nothing when project config is unavailable', async () => {
    const { container } = render(<TerminalClaudeCodeTab sessionId={sessionId} sessionName="work" />);
    await waitFor(() => {
      expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledWith({
        agent_id: 'test-agent-1',
        scope: 'project',
        session_id: sessionId,
      });
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders the tab button when project config is available', async () => {
    vi.mocked(claudeCodeApi.claudeCodeList).mockResolvedValue(listResponse);
    render(<TerminalClaudeCodeTab sessionId={sessionId} sessionName="work" />);
    const tabButton = await screen.findByRole('button', { name: 'CC' });
    expect(tabButton).toBeDefined();
    expect(claudeCodeApi.claudeCodeList).toHaveBeenCalledWith({
      agent_id: 'test-agent-1',
      scope: 'project',
      session_id: sessionId,
    });
  });

  it('opens the config viewer and loads file content through claudeCodeApi', async () => {
    const user = userEvent.setup();
    vi.mocked(claudeCodeApi.claudeCodeList).mockResolvedValue(listResponse);
    render(<TerminalClaudeCodeTab sessionId={sessionId} sessionName="work" />);

    await user.click(await screen.findByRole('button', { name: 'CC' }));
    await user.click(await screen.findByRole('button', { name: 'settings.json' }));

    expect(await screen.findByText('{"apiKey":"x"}')).toBeDefined();
    expect(claudeCodeApi.claudeCodeRead).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: 'test-agent-1',
        scope: 'project',
        session_id: sessionId,
        path: 'settings.json',
        offset: 0,
      }),
    );
  });
});
