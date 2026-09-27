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

/**
 * Renders the view, defaulting to the **push** layout.
 *
 * The default is `push` because that is what every test below was written
 * against before there was a second layout, and keeping it means they go on
 * asserting the behaviour they were written for rather than quietly being
 * rewritten to the new one. Master/detail has its own tests further down.
 */
function renderView(view: ConversationViewState, handlers: Partial<{
  onSelect: (id: string | null) => void;
  onLoadOlder: () => void;
  onReload: () => void;
}> = {}, layout: 'master-detail' | 'push' = 'push') {
  const onSelect = handlers.onSelect ?? vi.fn();
  const onLoadOlder = handlers.onLoadOlder ?? vi.fn();
  const onReload = handlers.onReload ?? vi.fn();
  render(
    <ConversationView
      view={view}
      layout={layout}
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

  it('puts the user on the right and Claude on the left', () => {
    // #1120's alignment rule, and the assertion that the transcript hands each
    // record to the right one of `UserMessage` / `AssistantMessage`.
    //
    // It needs to be its own test because nothing else here would notice a swap:
    // `data-kind` comes from the item rather than the component, and the text is
    // the same either way, so exchanging the two primitives would leave the rest
    // of this file green. Alignment is also the half of the distinction that
    // survives not being able to see the colour — `#1120` is explicit that
    // "alignment also carries identity".
    renderView(state({ items: turns }));

    const rendered = screen.getAllByTestId('conversation-turn');
    expect(rendered[0]!.className).toContain('items-end');
    expect(rendered[1]!.className).toContain('items-start');
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
      {
        claude_session_id: 'claude-1',
        cwd: '/work',
        updated_at: '2026-09-25T10:00:00Z',
        title: 'terminal ownership handoff',
      },
      {
        claude_session_id: 'claude-2',
        cwd: '/work',
        updated_at: '2026-09-25T09:00:00Z',
        title: 'capsule radius',
      },
    ];
    const { onSelect } = renderView(state({ state: 'ambiguous', conversation: null, candidates }));

    expect(screen.queryByTestId('conversation-open')).not.toBeInTheDocument();
    // Found by its **title**, which is the behaviour this covers: a row used to
    // be named by its UUID, and a UUID is not a name (#1120).
    expect(
      screen.getAllByRole('button', { name: /terminal ownership handoff|capsule radius/ }),
    ).toHaveLength(2);
    // The other half of that claim, and the assertion that can fail if the
    // identity leaks back into the name — the UUID is still an `@title`, so
    // this distinguishes "reachable" from "what the row is called".
    expect(screen.queryByRole('button', { name: /claude-[12]/ })).not.toBeInTheDocument();

    // And choosing is what opens one — the id the provider will resolve.
    screen.getByRole('button', { name: /capsule radius/ }).click();
    expect(onSelect).toHaveBeenCalledWith('claude-2');
  });

  it('shows what was last asked under the title, and degrades when there is none', () => {
    // The row is two lines (#1120 item 5): the title says what a conversation
    // is called, the preview says where it got to. Measured, both halves can be
    // missing independently, so this asserts the *pair* rather than the
    // presence of either — one candidate has both, the other has a title only.
    const candidates = [
      {
        claude_session_id: 'claude-1',
        cwd: '/work',
        updated_at: '2026-09-25T10:00:00Z',
        title: 'terminal ownership handoff',
        preview: 'review the controller/observer handoff',
      },
      {
        claude_session_id: 'claude-2',
        cwd: '/work',
        updated_at: '2026-09-25T09:00:00Z',
        title: 'capsule radius',
      },
    ];
    renderView(state({ state: 'ambiguous', conversation: null, candidates }));

    const previews = screen.getAllByTestId('conversation-candidate-preview');
    expect(previews).toHaveLength(1);
    expect(previews[0]).toHaveTextContent('review the controller/observer handoff');

    // Both titles still carry their own text, which is what makes the preview a
    // second line rather than a replacement for the first. Asserted on the
    // *content* and not just on the element count: a row that drew the preview
    // where the title belongs would still have two title elements, so counting
    // them would pass on exactly the failure this is here to catch.
    expect(
      screen.getAllByTestId('conversation-candidate-title').map((el) => el.textContent),
    ).toEqual(['terminal ownership handoff', 'capsule radius']);
  });

  it('keeps the list and the open conversation on screen together in master/detail', () => {
    // #1120 item 8. The two are read against each other — you choose a
    // conversation *by* comparing it to the one you have open — so the layout
    // that has the width shows both.
    const candidates = [
      {
        claude_session_id: 'claude-1',
        cwd: '/work',
        updated_at: '2026-09-25T10:00:00Z',
        title: 'terminal ownership handoff',
      },
    ];
    renderView(
      state({ state: 'ready', conversation: { claude_session_id: 'claude-1', cwd: '/work' }, candidates, items: turns }),
      {},
      'master-detail',
    );

    expect(screen.getByTestId('conversation-master-detail')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-list')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-open')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-candidates')).toBeInTheDocument();
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2);
  });

  it('drops the controls that only mean something when the list is behind you', () => {
    // "All conversations" and "Back to conversation" both navigate between two
    // things that master/detail already shows at once. Leaving them in would be
    // two buttons that appear to do nothing, which is worse than no button —
    // and this is the assertion that keeps them from creeping back.
    const candidates = [
      {
        claude_session_id: 'claude-1',
        cwd: '/work',
        updated_at: '2026-09-25T10:00:00Z',
        title: 'terminal ownership handoff',
      },
    ];
    renderView(
      state({ state: 'ready', conversation: { claude_session_id: 'claude-1', cwd: '/work' }, candidates, items: turns }),
      {},
      'master-detail',
    );

    expect(screen.queryByTestId('conversation-show-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversation-back')).not.toBeInTheDocument();
  });

  it('leaves the list usable when nothing is open, rather than covering it', () => {
    // The empty detail is an empty *pane*. The list beside it is a complete
    // answer, so replacing the whole capability with a notice would take away
    // the thing the reader needs in order to act on it.
    const candidates = [
      {
        claude_session_id: 'claude-1',
        cwd: '/work',
        updated_at: '2026-09-25T10:00:00Z',
        title: 'terminal ownership handoff',
      },
    ];
    renderView(
      state({ state: 'ambiguous', conversation: null, candidates }),
      {},
      'master-detail',
    );

    expect(screen.getByTestId('conversation-nothing-open')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-candidates')).toBeInTheDocument();
  });

  it('does not render the master/detail grid in the push layout', () => {
    // #1120 item 9: App must not get the Web grid shrunk down. Asserted as an
    // absence, because "App looks fine" is not something a passing render says
    // — the failure would be a grid that technically fits and reads badly.
    renderView(state({ state: 'ready', items: turns }));

    expect(screen.queryByTestId('conversation-master-detail')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-open')).toBeInTheDocument();
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
        layout="push"
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
        layout="push"
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
