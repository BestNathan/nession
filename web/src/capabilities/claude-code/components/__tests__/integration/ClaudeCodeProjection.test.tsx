import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProjection } from '../../ClaudeCodeProjection';
import { claudeCodeApi } from '../../../ClaudeCodePlugin';
import type { ClaudeCodeConversationsResponse } from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeList: vi.fn(),
    claudeCodeRead: vi.fn(),
    claudeCodeConversations: vi.fn(),
  },
}));

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

/**
 * A directory with several conversations and no binding.
 *
 * The state `#1005` forbids guessing in, and the one that says whether the Peek
 * has anything of its own to offer: without candidates it could only repeat what
 * the state line already said.
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

function renderProjection(state: 'active' | 'relevant') {
  return render(
    <ClaudeCodeProjection
      agentId="a1"
      sessionId="a1:work"
      state={state}
      openDetail={vi.fn()}
    />,
  );
}

/**
 * One body, so one describe: the Signal this capability used to be drawn as
 * went with the depth axis, and nothing here could report a second answer.
 */
describe('Claude Code projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedConversation.mockResolvedValue(noConversation());
  });

  it('names the work when the Session has a titled conversation', async () => {
    // The change #1120 asks for: the line under the state is about the work,
    // not about the repository. A pane mid-conversation does not need to be
    // told how many CLAUDE.md files exist.
    mockedConversation.mockResolvedValue(boundTo('terminal ownership handoff'));

    renderProjection('active');

    expect(await screen.findByTestId('claude-code-peek-body')).toHaveTextContent(
      'terminal ownership handoff',
    );
    expect(mockedConversation).toHaveBeenCalledWith({
      agent_id: 'a1',
      session_id: 'a1:work',
    });
  });

  it('says the pane is running it, and that it ran earlier, in different words', async () => {
    const { unmount } = renderProjection('active');
    expect(await screen.findByTestId('claude-code-peek-body')).toHaveTextContent('Running');
    unmount();

    renderProjection('relevant');
    expect(await screen.findByTestId('claude-code-peek-body')).toHaveTextContent(
      'Ran in this Session earlier',
    );
  });

  it('names the bound conversation and offers the way into it', async () => {
    mockedConversation.mockResolvedValue(boundTo('terminal ownership handoff'));
    renderProjection('active');

    const peek = await screen.findByTestId('claude-code-peek-body');
    expect(peek).toHaveTextContent('terminal ownership handoff');
    expect(peek).toHaveTextContent('Running in this Session');
  });

  it('offers the candidates when nothing is bound, and chooses none of them', async () => {
    mockedConversation.mockResolvedValue(unbound('terminal ownership handoff', 'capsule radius'));
    renderProjection('active');

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
    renderProjection('active');

    const list = await screen.findByTestId('claude-code-peek-candidates');
    expect(list).toHaveTextContent('named');
    expect(list).toHaveTextContent('Conversation ·');
  });

  it('says there is nothing rather than drawing an empty frame', async () => {
    // A capability that exists must still be worth opening. An empty Peek reads
    // as a bug, which is a worse answer than "there is none".
    renderProjection('active');

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
        state="active"
        onOpenWorkspace={onOpenWorkspace}
        openDetail={vi.fn()}
      />,
    );

    (await screen.findByText('second')).click();

    expect(onOpenWorkspace).toHaveBeenCalledWith('c2');
  });
});
