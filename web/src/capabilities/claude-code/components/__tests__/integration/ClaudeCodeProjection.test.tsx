import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProjection } from '../../ClaudeCodeProjection';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeListResponse } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: { claudeCodeList: vi.fn(), claudeCodeRead: vi.fn() },
}));

const mockedList = vi.mocked(claudeCodeApi.claudeCodeList);

function listResponse(overrides: Partial<ClaudeCodeListResponse> = {}): ClaudeCodeListResponse {
  return {
    available: true,
    categories: [
      {
        name: 'Instructions',
        icon: null,
        files: [{ path: 'CLAUDE.md', size: 10, content_type: 'markdown' }],
      },
      {
        name: 'Settings',
        icon: null,
        files: [{ path: 'settings.json', size: 10, content_type: 'json' }],
      },
    ],
    ...overrides,
  };
}

function renderProjection(state: 'active' | 'relevant') {
  render(<ClaudeCodeProjection agentId="a1" sessionId="a1:work" state={state} />);
}

describe('Claude Code Signal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue(listResponse());
  });

  it('says the pane is running it, and that it ran earlier, in different words', async () => {
    const { unmount } = render(
      <ClaudeCodeProjection agentId="a1" sessionId="a1:work" state="active" />,
    );
    expect(await screen.findByTestId('claude-code-signal-body')).toHaveTextContent('Running');
    unmount();

    renderProjection('relevant');
    expect(await screen.findByTestId('claude-code-signal-body')).toHaveTextContent(
      'Ran in this Session earlier',
    );
  });

  it('reports project config, which is the fact the pane does not show', async () => {
    renderProjection('active');

    expect(await screen.findByTestId('claude-code-signal-body')).toHaveTextContent(
      '2 project config files',
    );
    // The project half only: the global half belongs to the machine, not to the
    // Session the user is sitting in.
    expect(mockedList).toHaveBeenCalledWith({
      agent_id: 'a1',
      scope: 'project',
      session_id: 'a1:work',
    });
  });

  it('distinguishes "no config" from "not installed"', async () => {
    // A Signal reports state, not absence-for-two-different-reasons.
    mockedList.mockResolvedValue(listResponse({ categories: [] }));
    const { unmount } = render(
      <ClaudeCodeProjection agentId="a1" sessionId="a1:work" state="active" />,
    );
    expect(await screen.findByTestId('claude-code-signal-body')).toHaveTextContent(
      'No project config',
    );
    unmount();

    mockedList.mockResolvedValue(listResponse({ available: false, categories: [] }));
    renderProjection('active');
    expect(await screen.findByTestId('claude-code-signal-body')).toHaveTextContent(
      'Not installed on this host',
    );
  });

  it('says nothing about config when the request fails', async () => {
    // A Signal that cannot report does not report a failure: the config browser
    // is where that gets explained and acted on, and a Signal is not the place
    // to put an error the user can do nothing about.
    mockedList.mockRejectedValue(new Error('offline'));

    renderProjection('active');

    const body = await screen.findByTestId('claude-code-signal-body');
    expect(body).toHaveTextContent('Running in this Session');
    expect(body).not.toHaveTextContent('offline');
  });
});
