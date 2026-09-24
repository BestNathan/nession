import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConversationView } from '../../ConversationView';
import type { ConversationViewState } from '../../../hooks/useConversation';

function state(overrides: Partial<ConversationViewState> = {}): ConversationViewState {
  return {
    state: 'ready',
    conversation: { claude_session_id: 'claude-1', cwd: '/work' },
    candidates: [],
    items: [],
    hasMore: false,
    partialTail: false,
    skipped: 0,
    loading: false,
    loadingOlder: false,
    error: null,
    ...overrides,
  };
}

function renderView(view: ConversationViewState, handlers: Partial<{
  onSelect: (id: string | null) => void;
  onLoadOlder: () => void;
  onReload: () => void;
}> = {}) {
  const onSelect = handlers.onSelect ?? vi.fn();
  const onLoadOlder = handlers.onLoadOlder ?? vi.fn();
  const onReload = handlers.onReload ?? vi.fn();
  render(
    <ConversationView
      view={view}
      onSelect={onSelect}
      onLoadOlder={onLoadOlder}
      onReload={onReload}
    />,
  );
  return { onSelect, onLoadOlder, onReload };
}

const turns = [
  { id: '1', kind: 'user' as const, timestamp: '2026-09-25T10:00:00Z', text: 'hello' },
  { id: '2', kind: 'assistant' as const, timestamp: '2026-09-25T10:00:05Z', text: 'hi there' },
  {
    id: '3',
    kind: 'tool' as const,
    timestamp: '2026-09-25T10:00:06Z',
    text: 'the whole result',
    tool: { name: 'Bash', summary: 'ls -la', is_error: false, truncated: false },
  },
];

describe('ConversationView', () => {
  it('renders user and assistant turns with their text', () => {
    renderView(state({ items: turns }));

    const rendered = screen.getAllByTestId('conversation-turn');
    expect(rendered.map((el) => el.getAttribute('data-kind'))).toEqual(['user', 'assistant']);
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('hi there')).toBeInTheDocument();
  });

  it('collapses tool calls so they do not drown the conversation', () => {
    // #1005 criterion 10. The summary is one line and the body is closed until
    // asked for — a conversation that renders every tool result in full is a
    // conversation nobody can read the turns in.
    renderView(state({ items: turns }));

    const tool = screen.getByTestId('conversation-tool');
    expect(tool).not.toHaveAttribute('open');
    expect(screen.getByTestId('conversation-tool-name')).toHaveTextContent('Bash');
    expect(screen.getByText('ls -la')).toBeInTheDocument();
  });

  it('says a finished conversation is finished but still shows it', () => {
    // #1005 criterion 4: Claude exiting does not take the conversation away.
    // The distinction the user needs is "not live", not "gone".
    renderView(state({ state: 'inactive', items: turns }));

    expect(screen.getByTestId('conversation-state')).toHaveTextContent('Finished');
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2);
  });

  it('says a running conversation is running now', () => {
    renderView(state({ state: 'ready', items: turns }));
    expect(screen.getByTestId('conversation-state')).toHaveTextContent('Running now');
  });

  it('offers the candidate list instead of choosing when the provider could not resolve one', () => {
    // The whole point of `ambiguous`: the client must not pick. Nothing is
    // opened, and the list is what is shown.
    const candidates = [
      { claude_session_id: 'claude-1', cwd: '/work', updated_at: '2026-09-25T10:00:00Z' },
      { claude_session_id: 'claude-2', cwd: '/work', updated_at: '2026-09-25T09:00:00Z' },
    ];
    const { onSelect } = renderView(state({ state: 'ambiguous', conversation: null, candidates }));

    expect(screen.queryByTestId('conversation-open')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /claude-[12]/ })).toHaveLength(2);

    // And choosing is what opens one — the id the provider will resolve.
    screen.getByRole('button', { name: /claude-2/ }).click();
    expect(onSelect).toHaveBeenCalledWith('claude-2');
  });

  it('lets a user go back to the list and return to the conversation', async () => {
    // #1005 decision 3: the list is an entry point the user can always return
    // to, not a fallback shown only when resolution failed.
    const user = userEvent.setup();
    const candidates = [{ claude_session_id: 'claude-1', cwd: '/work', updated_at: null }];
    renderView(state({ candidates, items: turns }));

    await user.click(screen.getByTestId('conversation-show-list'));
    expect(screen.getByTestId('conversation-list')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-open')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('conversation-back'));
    expect(screen.getByTestId('conversation-open')).toBeInTheDocument();
  });

  it('offers an older page when the provider says there is one', async () => {
    const user = userEvent.setup();
    const { onLoadOlder } = renderView(state({ items: turns, hasMore: true }));

    await user.click(screen.getByTestId('conversation-load-older'));
    expect(onLoadOlder).toHaveBeenCalled();
  });

  it('offers no older page when there is nothing earlier', () => {
    renderView(state({ items: turns, hasMore: false }));
    expect(screen.queryByTestId('conversation-load-older')).not.toBeInTheDocument();
  });

  it('reports a partial tail and skipped records rather than hiding them', () => {
    // Criterion 6 and constraint 7: a transcript being appended to, or one
    // carrying records this version does not model, must still open — and the
    // client must be able to say so rather than presenting it as complete.
    renderView(state({ items: turns, partialTail: true, skipped: 3 }));

    expect(screen.getByTestId('conversation-partial')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-skipped')).toHaveTextContent('3');
  });

  it('gives every state the provider can answer with a rendering', () => {
    // None of these is a blank panel: each is an answer a user can act on.
    const { unmount } = render(
      <ConversationView
        view={state({ state: 'not_found', conversation: null })}
        onSelect={vi.fn()}
        onLoadOlder={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    expect(screen.getByTestId('conversation-not-found')).toBeInTheDocument();
    unmount();

    render(
      <ConversationView
        view={state({ state: 'unavailable', conversation: null })}
        onSelect={vi.fn()}
        onLoadOlder={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    expect(screen.getByTestId('conversation-unavailable')).toBeInTheDocument();
  });

  it('shows a read failure with a retry rather than an empty conversation', async () => {
    const user = userEvent.setup();
    const { onReload } = renderView(state({ state: 'error', error: 'the transcript could not be read' }));

    expect(screen.getByRole('alert')).toHaveTextContent('the transcript could not be read');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onReload).toHaveBeenCalled();
  });
});
