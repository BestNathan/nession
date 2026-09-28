import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConversationView } from '../../ConversationView';
import type { ConversationViewState } from '../../../hooks/useConversation';
import type { ConversationItems } from '../../../model/conversationPositions';

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
    olderError: null,
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

const turns: ConversationItems = [
  {
    id: '1',
    kind: 'message',
    role: 'user',
    timestamp: '2026-09-25T10:00:00Z',
    content: [{ type: 'text', text: 'hello' }],
  },
  {
    id: '2',
    kind: 'message',
    role: 'assistant',
    timestamp: '2026-09-25T10:00:05Z',
    content: [{ type: 'text', text: 'hi there' }],
  },
  {
    id: '3',
    kind: 'tool',
    timestamp: '2026-09-25T10:00:06Z',
    tool: {
      call_id: 'c1',
      name: 'Bash',
      status: 'success',
      summary: 'ls -la',
      output: { text: 'the whole result', kind: 'text', truncated: false },
    },
  },
];

describe('ConversationView', () => {
  it('renders user and assistant turns with their text', () => {
    renderView(state({ items: turns }));

    const rendered = screen.getAllByTestId('conversation-turn');
    // `kind` is the wire's tag — both turns are `message` now — and the speaker
    // is the separate fact the wire carries on `role`. Asserting both is what
    // says the frame reports the item rather than flattening one into the other.
    expect(rendered.map((el) => el.getAttribute('data-kind'))).toEqual(['message', 'message']);
    expect(rendered.map((el) => el.getAttribute('data-role'))).toEqual(['user', 'assistant']);
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
    // The user's turn is pushed to the end of the row; Claude's is not — it
    // stretches, so that its code fences scroll inside a definite width instead
    // of widening the column. Asserting `items-start` here would pin the older
    // value and the overflow it caused; what matters is that the two are not
    // both anchored the same way.
    expect(rendered[0]!.className).toContain('items-end');
    expect(rendered[1]!.className).not.toContain('items-end');
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

  it('groups the list by date, newest bucket first', () => {
    // #1120 item 5's optional half. The dates are *relative to the real clock*
    // here, unlike `dateBucket`'s own tests which inject one — the component
    // calls it without a `now`, and the alternative would be threading a clock
    // prop through the view purely for this. That is safe because the buckets
    // are days apart: 3 days back is inside the previous week whether the suite
    // runs at 00:01 or 23:59, which is not true of a boundary test but is true
    // of this one.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const candidates = [
      { claude_session_id: 'a', cwd: '/work', updated_at: daysAgo(0), title: 'today one' },
      { claude_session_id: 'b', cwd: '/work', updated_at: daysAgo(3), title: 'recent one' },
      { claude_session_id: 'c', cwd: '/work', updated_at: daysAgo(40), title: 'old one' },
      // No timestamp at all — the provider sorts these last, and they must not
      // be filed under "Older", which would assert a recency nothing knows.
      { claude_session_id: 'd', cwd: '/work', updated_at: null, title: 'undated one' },
    ];
    renderView(state({ state: 'ambiguous', conversation: null, candidates }));

    expect(
      screen.getAllByTestId('conversation-bucket').map((el) => el.textContent),
    ).toEqual(['Today', 'Previous 7 days', 'Older']);

    // Every row still renders, including the undated one — a grouping that
    // dropped it would look tidy and lose a conversation.
    expect(screen.getAllByTestId('conversation-candidate-title').map((el) => el.textContent)).toEqual(
      ['today one', 'recent one', 'old one', 'undated one'],
    );

    // And the undated row is under **no** heading, which the order above cannot
    // show: filing it under "Older" would leave the titles in exactly the same
    // sequence, so an order assertion passes on the bug this exists to prevent.
    expect(screen.getByText('undated one').closest('section')).toBeNull();
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

  it('does not render a Load older button; transcript scroll owns pagination (#1190)', () => {
    renderView(state({ items: turns, hasMore: true }));
    expect(screen.queryByTestId('conversation-load-older')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-transcript-scroll')).toBeInTheDocument();
  });

  it('gives push-layout conversation history a bounded scroll owner (#1189)', () => {
    renderView(state({ state: 'ambiguous', conversation: null, candidates: [
      { claude_session_id: 'a', cwd: '/work', updated_at: null, title: 'one' },
    ] }));

    const scroll = screen.getByTestId('conversation-list-scroll');
    expect(scroll.className).toMatch(/overflow-y-auto/);
    expect(scroll.className).toMatch(/min-h-0/);
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

/**
 * #1167's content grammar: prose as Markdown, code as a readable surface, and a
 * tool call as one activity that can be opened.
 */
describe('ConversationView — structured transcript', () => {
  function message(text: string, role: 'user' | 'assistant' = 'assistant'): ConversationItems[number] {
    return { id: `m-${text}`, kind: 'message', role, content: [{ type: 'text', text }] };
  }

  function tool(overrides: Partial<Extract<ConversationItems[number], { kind: 'tool' }>['tool']> = {}): ConversationItems[number] {
    return {
      id: 'tool-1',
      kind: 'tool',
      tool: {
        call_id: 'c1',
        name: 'Bash',
        status: 'success',
        summary: 'cargo test',
        ...overrides,
      },
    };
  }

  it('renders assistant prose as Markdown rather than as literal text', () => {
    // The headline of #1167: a heading, a list and emphasis have to become
    // elements. Asserting on the *element* is the point — text matching would
    // pass just as well if the asterisks were still on screen.
    renderView(state({ items: [message('# Heading\n\n- one\n- two\n\n**bold**')] }));

    expect(
      screen.getByRole('heading', { name: 'Heading' }),
      'the Markdown heading did not become an element',
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('bold')).toHaveProperty('tagName', 'STRONG');
  });

  it('keeps a Markdown heading below the page heading', () => {
    // A message is not a page. A `#` rendered as an `<h1>` would compete with
    // the Workspace's own heading and rewrite the document outline with
    // whatever the model happened to write.
    renderView(state({ items: [message('# Heading')] }));

    expect(screen.getByRole('heading', { name: 'Heading' })).toHaveProperty('tagName', 'H2');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('gives a fenced block its language and a way to copy it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderView(state({ items: [message('```rust\nfn main() {}\n```')] }));

    expect(screen.getByTestId('code-block-language')).toHaveTextContent('rust');
    await user.click(screen.getByRole('button', { name: /copy rust code/i }));
    // The *source*, not the rendered element's text: the copy has to be
    // something that can be pasted back into a file.
    expect(writeText).toHaveBeenCalledWith('fn main() {}\n');
  });

  it('drops raw HTML in a message instead of executing it', () => {
    // The sanitizer's promise, asserted from the consumer's side. There is no
    // `rehype-raw` anywhere in the tree, so a raw node never becomes an
    // element — this is what makes the transcript safe to render at all.
    renderView(state({ items: [message('<img src=x onerror="alert(1)">')] }));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('onerror');
  });

  it('shows a tool call collapsed by default, with its arguments and result apart', () => {
    // Collapsed is the default the whole design rests on (#1005 criterion 10).
    // It is asserted on the `open` attribute rather than on the body's absence
    // because a native `<details>` keeps its children in the DOM either way —
    // jsdom does not model their hiddenness, so "not in the document" would be
    // an assertion about jsdom, not about this component.
    renderView(
      state({
        items: [
          tool({
            input: { text: '{"command":"cargo test"}', kind: 'json', truncated: false },
            output: { text: '42 tests passed', kind: 'text', truncated: false },
          }),
        ],
      }),
    );

    expect(screen.getByTestId('conversation-tool')).not.toHaveAttribute('open');
    // Two sections, named — the separation #1167 asks for, rather than one blob.
    expect(screen.getByRole('heading', { name: 'Input' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Output' })).toBeInTheDocument();
    expect(screen.getByText('42 tests passed')).toBeInTheDocument();
    // `[object Object]` is the failure the JSON payload exists to prevent.
    expect(screen.getByText(/"command":"cargo test"/)).toBeInTheDocument();
  });

  it('says a tool failed without relying on colour', () => {
    renderView(state({ items: [tool({ status: 'error', output: { text: 'boom', kind: 'text', truncated: false } })] }));

    expect(screen.getByTestId('conversation-tool')).toHaveAttribute('data-status', 'error');
    // The word, not only the red. A screen reader and a monochrome display both
    // need the status to be readable.
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('marks a truncated body so a short answer is not mistaken for the whole one', () => {
    renderView(
      state({ items: [tool({ output: { text: 'the first part', kind: 'text', truncated: true } })] }),
    );

    expect(screen.getByTestId('conversation-tool-truncated')).toHaveTextContent('truncated');
  });

  it('says a call whose outcome was not loaded is unknown, not still running', () => {
    // `running` and `unknown` are different claims, and the provider only makes
    // the first when it knows there is nothing newer in the transcript.
    renderView(state({ items: [tool({ status: 'unknown', output: undefined })] }));

    expect(screen.getByText('outcome not loaded')).toBeInTheDocument();
    expect(screen.queryByText('still running')).not.toBeInTheDocument();
  });

  it('shows a record this version cannot read rather than a hole where it was', () => {
    renderView(state({ items: [{ id: 'u1', kind: 'unknown' }] }));

    expect(screen.getByTestId('conversation-unknown')).toBeInTheDocument();
  });
});
