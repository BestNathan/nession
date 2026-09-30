import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationTranscript } from '../../ConversationTranscript';
import type { ConversationViewState } from '../../../hooks/useConversation';

function viewState(overrides: Partial<ConversationViewState> = {}): ConversationViewState {
  return {
    listState: 'ready',
    conversations: [],
    binding: null,
    messagesState: 'ready',
    openId: 'claude-1',
    conversation: { id: 'claude-1', cwd: '/work' },
    activity: 'active',
    items: [{ id: '1', kind: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    hasMore: false,
    partialTail: false,
    skipped: 0,
    loading: false,
    loadingOlder: false,
    olderError: null,
    error: null,
    ...overrides,
  };
}

describe('ConversationTranscript scroll (#1190)', () => {
  it('renders the viewport with items', () => {
    render(
      <ConversationTranscript
        view={viewState({
          items: [
            { id: '1', kind: 'message', role: 'user', content: [{ type: 'text', text: 'a' }] },
            { id: '2', kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'b' }] },
          ],
        })}
        onLoadOlder={vi.fn()}
      />,
    );

    // MessageScroller renders a viewport with role="region" and aria-label="Messages"
    expect(screen.getByRole('region', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('shows inline older-page error without replacing the transcript', () => {
    render(
      <ConversationTranscript
        view={viewState({ olderError: 'network failed', items: [
          { id: '1', kind: 'message', role: 'user', content: [{ type: 'text', text: 'still here' }] },
        ] })}
        onLoadOlder={vi.fn()}
      />,
    );

    expect(screen.getByTestId('conversation-older-error')).toHaveTextContent('network failed');
    expect(screen.getByText('still here')).toBeInTheDocument();
  });

  it('shows a loading line instead of a Load older button', () => {
    render(
      <ConversationTranscript view={viewState({ hasMore: true, loadingOlder: true })} onLoadOlder={vi.fn()} />,
    );

    expect(screen.queryByTestId('conversation-load-older')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-loading-older')).toBeInTheDocument();
  });

  it('uses MessageScroller for scroll management', () => {
    render(
      <ConversationTranscript
        view={viewState({
          items: [
            { id: '1', kind: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
          ],
        })}
        onLoadOlder={vi.fn()}
      />,
    );

    // Verify MessageScroller structure is present
    expect(document.querySelector('[data-slot="message-scroller"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="message-scroller-viewport"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="message-scroller-content"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="message-scroller-item"]')).toBeInTheDocument();
  });
});
