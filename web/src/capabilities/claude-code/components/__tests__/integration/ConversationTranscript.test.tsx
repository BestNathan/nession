import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationTranscript } from '../../ConversationTranscript';
import type { ConversationViewState } from '../../../hooks/useConversation';

function viewState(overrides: Partial<ConversationViewState> = {}): ConversationViewState {
  return {
    state: 'ready',
    conversation: { claude_session_id: 'claude-1', cwd: '/work' },
    candidates: [],
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
  it('places the viewport at the latest message on first open', async () => {
    const { rerender } = render(
      <ConversationTranscript view={viewState({ items: [] })} onLoadOlder={vi.fn()} />,
    );

    rerender(
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

    const el = screen.getByTestId('conversation-transcript-scroll');
    await waitFor(() => {
      expect(el.scrollTop).toBe(el.scrollHeight);
    });
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
});
