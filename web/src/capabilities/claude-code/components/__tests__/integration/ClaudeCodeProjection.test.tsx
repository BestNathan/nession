import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProjection } from '../../ClaudeCodeProjection';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeConversationsResponse, ClaudeCodeListResponse } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeList: vi.fn(),
    claudeCodeRead: vi.fn(),
    claudeCodeConversations: vi.fn(),
  },
}));

const mockedList = vi.mocked(claudeCodeApi.claudeCodeList);
const mockedConversation = vi.mocked(claudeCodeApi.claudeCodeConversations);

/** A Session with no conversation at this cwd — read, and empty (#1222). */
function noConversation(): ClaudeCodeConversationsResponse {
  return { state: 'ready', items: [], has_more: false };
}

/**
 * A Session bound to a conversation named `title`.
 *
 * `title` is nullable because a real transcript may carry none — measured, 3 of
 * 14 — and the two cases say different things.
 */
function boundTo(title: string | null): ClaudeCodeConversationsResponse {
  return {
    state: 'ready',
    items: [{ id: 'c1', cwd: '/work', updated_at: null, title }],
    binding: { conversation_id: 'c1', activity: 'active' },
    has_more: false,
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

function renderProjection(state: 'active' | 'relevant', depth: 'signal' | 'peek' = 'signal') {
  render(
    <ClaudeCodeProjection
      agentId="a1"
      sessionId="a1:work"
      depth={depth}
      state={state}
      openDetail={vi.fn()}
    />,
  );
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
      <ClaudeCodeProjection agentId="a1" sessionId="a1:work" depth="signal" state="active" openDetail={vi.fn()} />,
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
      <ClaudeCodeProjection agentId="a1" sessionId="a1:work" depth="signal" state="active" openDetail={vi.fn()} />,
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

/**
 * A directory with several conversations and no binding.
 *
 * The state `#1005` forbids guessing in, and the one that decides whether the
 * Peek is a real second depth or a bigger Signal: a Peek that cannot offer the
 * candidates has nothing to say that the Signal did not.
 */
function unbound(...titles: (string | null)[]): ClaudeCodeConversationsResponse {
  return {
    state: 'ready',
    items: titles.map((title, index) => ({
      id: `c${index + 1}`,
      cwd: '/work',
      // Dated, because that is what the fallback renders from: a titleless
      // candidate with no timestamp degrades to the bare word "Conversation",
      // which is a different (and deader) answer than the date it should show.
      updated_at: '2026-09-01T09:05:00Z',
      title,
    })),
    // No binding — which is not an `ambiguous` state anymore: the list is the
    // answer (#1222), and choosing from it is what #1005 forbids.
    has_more: false,
  };
}

describe('Claude Code Peek', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue(listResponse());
    mockedConversation.mockResolvedValue(noConversation());
  });

  it('names the bound conversation and offers the way into it', async () => {
    mockedConversation.mockResolvedValue(boundTo('terminal ownership handoff'));
    renderProjection('active', 'peek');

    const peek = await screen.findByTestId('claude-code-peek-body');
    expect(peek).toHaveTextContent('terminal ownership handoff');
    expect(peek).toHaveTextContent('Running in this Session');
    // Not the Signal's body: the two depths are different renderings, and an
    // assertion on the wrong one would pass while the Peek was empty.
    expect(screen.queryByTestId('claude-code-signal-body')).not.toBeInTheDocument();
  });

  it('offers the candidates when nothing is bound, and chooses none of them', async () => {
    mockedConversation.mockResolvedValue(unbound('terminal ownership handoff', 'capsule radius'));
    renderProjection('active', 'peek');

    const peek = await screen.findByTestId('claude-code-peek-body');
    expect(peek).toHaveTextContent('2 conversations in this directory');
    expect(screen.getByTestId('claude-code-peek-candidates')).toHaveTextContent(
      'terminal ownership handoff',
    );
    // The listing says which ones exist; it does not say which one is current,
    // because the provider did not — saying so would be the guess #1005 bans.
    expect(peek).not.toHaveTextContent('current');
  });

  it('renders the untitled candidate through the fallback rather than blank', async () => {
    mockedConversation.mockResolvedValue(unbound('named', null));
    renderProjection('active', 'peek');

    const list = await screen.findByTestId('claude-code-peek-candidates');
    expect(list).toHaveTextContent('named');
    expect(list).toHaveTextContent('Conversation ·');
  });

  it('says there is nothing rather than drawing an empty frame', async () => {
    // A capability that exists must still be worth opening. An empty Peek reads
    // as a bug, which is a worse answer than "there is none".
    renderProjection('active', 'peek');

    expect(await screen.findByTestId('claude-code-peek-body')).toHaveTextContent(
      'No conversation in this Session',
    );
  });

  it('deepens with the item that was tapped, not with nothing', async () => {
    // Content navigation: the row is the capability's (only it knows which
    // candidate the user picked), the routing is the host's. The destination
    // action itself is the host's too (#1347 SC-21) — this is the body's
    // scrollable content, not a second destination.
    mockedConversation.mockResolvedValue(unbound('first', 'second'));
    const onOpenWorkspace = vi.fn();
    render(
      <ClaudeCodeProjection
        agentId="a1"
        sessionId="a1:work"
        depth="peek"
        state="active"
        onOpenWorkspace={onOpenWorkspace}
        openDetail={vi.fn()}
      />,
    );

    (await screen.findByText('second')).click();

    expect(onOpenWorkspace).toHaveBeenCalledWith('c2');
  });
});
