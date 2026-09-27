import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProjection } from '../../ClaudeCodeProjection';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeConversationResponse, ClaudeCodeListResponse } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeList: vi.fn(),
    claudeCodeRead: vi.fn(),
    claudeCodeConversation: vi.fn(),
  },
}));

const mockedList = vi.mocked(claudeCodeApi.claudeCodeList);
const mockedConversation = vi.mocked(claudeCodeApi.claudeCodeConversation);

/** A Session with no conversation at this cwd. */
function noConversation(): ClaudeCodeConversationResponse {
  return { state: 'not_found', has_more: false, partial_tail: false, skipped: 0 };
}

/**
 * A Session bound to a conversation named `title`.
 *
 * `title` is nullable because a real transcript may carry none — measured, 3 of
 * 14 — and the two cases say different things.
 */
function boundTo(title: string | null): ClaudeCodeConversationResponse {
  return {
    state: 'ready',
    conversation: { claude_session_id: 'c1', cwd: '/work' },
    candidates: [{ claude_session_id: 'c1', cwd: '/work', updated_at: null, title }],
    has_more: false,
    partial_tail: false,
    skipped: 0,
  };
}

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
    // The default is "no conversation", which is also what makes the config
    // assertions below meaningful: the count is what the Signal falls back to
    // when there is nothing readable to name the work.
    mockedConversation.mockResolvedValue(noConversation());
  });

  it('names the work when the Session has a titled conversation', async () => {
    // The change #1120 asks for: the line under the state is about the work,
    // not about the repository. A pane mid-conversation does not need to be
    // told how many CLAUDE.md files exist.
    mockedConversation.mockResolvedValue(boundTo('terminal ownership handoff'));

    renderProjection('active');

    expect(await screen.findByTestId('claude-code-signal-body')).toHaveTextContent(
      'terminal ownership handoff',
    );
    expect(mockedConversation).toHaveBeenCalledWith({
      agent_id: 'a1',
      session_id: 'a1:work',
    });
  });

  it('says a conversation exists when it is bound but unnamed', async () => {
    // About a fifth of real transcripts carry no title. Saying "available" is
    // honest and is not the same as saying nothing: it tells the user there is
    // something to open, which the config count does not.
    mockedConversation.mockResolvedValue(boundTo(null));

    renderProjection('active');

    const body = await screen.findByTestId('claude-code-signal-body');
    expect(body).toHaveTextContent('Conversation available');
    expect(body).not.toHaveTextContent('project config');
  });

  it('falls back to the config count when there is no conversation to name', async () => {
    renderProjection('active');

    expect(await screen.findByTestId('claude-code-signal-body')).toHaveTextContent(
      '2 project config files',
    );
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

  it('asks for the project config scope and not the global one', async () => {
    // The project half belongs to the Session the user is sitting in; the
    // global half belongs to the machine. Reading both would put a fact about
    // the computer on a surface that is about the work.
    renderProjection('active');

    await screen.findByTestId('claude-code-signal-body');
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
