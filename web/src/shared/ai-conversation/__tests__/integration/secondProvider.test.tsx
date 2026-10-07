import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ConversationView } from '../../components/ConversationView'
import { useAIConversation, type AIConversationHandle } from '../../runtime/useAIConversation'
import type { AIConversationAdapter } from '../../adapter/types'
import { SyntheticAdapter } from '../fixtures/syntheticAdapter'
import { assistantMessage, toolItem, userMessage } from '../fixtures/items'

/**
 * A second provider, end to end, through the shared UI.
 *
 * `#1363` SC-12 asks for exactly this: proof that a provider which is not
 * Claude Code can show a list, open a thread, stream, group tools, page
 * backwards and refresh — **without writing a component**. Everything below
 * this line is the shared framework plus an adapter; there is no provider
 * renderer to point at, which is the assertion.
 *
 * The adapter is deliberately unlike Claude Code: it pages the other way, it
 * has no binding semantics beyond "the one the context names", and it pushes
 * rather than polls. If the shared framework had quietly grown a Claude-shaped
 * assumption, one of those differences would break it here.
 */

/** The surface in miniature: the shared hook, the shared view, nothing else. */
function Harness({
  adapter,
  onReady,
  context = 'scope:one',
}: {
  adapter: AIConversationAdapter<string>
  onReady?: (handle: AIConversationHandle) => void
  context?: string
}) {
  const handle = useAIConversation(adapter, context)
  onReady?.(handle)
  return (
    <ConversationView
      snapshot={handle.snapshot}
      providerLabel={adapter.identity.label}
      layout="master-detail"
      onSelect={handle.select}
      onLoadOlder={handle.loadOlder}
      onReload={handle.reload}
    />
  )
}

function conversationAdapter(overrides: Partial<ConstructorParameters<typeof SyntheticAdapter>[0]> = {}) {
  return new SyntheticAdapter({
    conversations: [
      {
        id: 'thread-1',
        title: 'Something else entirely',
        preview: 'a prompt for another agent',
        activity: 'inactive',
        items: [
          userMessage('u1', 'do the thing'),
          toolItem('t1', { name: 'shell', category: 'command', summary: 'ls -la' }),
          toolItem('t2', { name: 'view', category: 'read', summary: '/etc/hosts' }),
          assistantMessage('a1', 'done'),
        ],
      },
    ],
    bindingId: 'thread-1',
    pageSize: 10,
    ...overrides,
  })
}

describe('a second provider through the shared conversation', () => {
  it('lists, opens and renders a thread without any provider component', async () => {
    render(<Harness adapter={conversationAdapter()} />)

    await waitFor(() => expect(screen.getByTestId('conversation-candidate-title')).toBeDefined())
    expect(screen.getByTestId('conversation-candidate-title').textContent).toBe(
      'Something else entirely',
    )

    // The binding opens the thread, and the speaker is named by the adapter —
    // the one thing `#1363` lets a provider vary about presentation.
    //
    // Two turns and a group, not four turns: the two tool calls are work, and
    // work collapses. Asserting four would be asserting that grouping is off.
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2))
    expect(screen.getByTestId('conversation-tool-group')).toBeDefined()
    expect(screen.getByText('Synthetic')).toBeDefined()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  it('groups work the adapter classified, in the shared vocabulary', async () => {
    render(<Harness adapter={conversationAdapter()} />)

    await waitFor(() => expect(screen.getByTestId('conversation-tool-group')).toBeDefined())
    // The categories are Nession's; the tool names (`shell`, `view`) never
    // reach the summary, only the group's body.
    expect(screen.getByTestId('conversation-tool-group-summary').textContent).toBe(
      '1 command · 1 file read',
    )
  })

  it('reaches the whole history through the provider it was given, oldest first', async () => {
    let handle: AIConversationHandle | undefined
    const adapter = new SyntheticAdapter({
      conversations: [{ id: 'thread-1', activity: 'inactive', items: [] }],
      bindingId: 'thread-1',
      // One item per page, so the transcript has to page twice to show three.
      pageSize: 1,
    })
    adapter.replaceItems(
      'thread-1',
      Array.from({ length: 3 }, (_, index) => userMessage(`u${index}`, `turn ${index}`)),
    )

    render(<Harness adapter={adapter} onReady={(value) => (handle = value)} />)
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(1))

    // The reader goes to the top. Everything after this is the shared trigger
    // doing its job against a provider it has never seen — one page at a time,
    // continuing on its own while the reader stays there, which is the
    // behaviour that regressed and is pinned in
    // `ConversationTranscriptPaging.test.tsx`.
    const viewport = document.querySelector('[data-slot="message-scroller-viewport"]')
    if (!(viewport instanceof HTMLElement)) {
      throw new Error('the transcript did not render a scroller viewport')
    }
    viewport.scrollTop = 0
    fireEvent.scroll(viewport)

    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(3))

    // Oldest first, and each prepend kept the order it arrived in.
    const turns = screen.getAllByTestId('conversation-turn')
    expect(within(turns[0] as HTMLElement).getByText('turn 0')).toBeDefined()
    expect(within(turns[1] as HTMLElement).getByText('turn 1')).toBeDefined()
    expect(within(turns[2] as HTMLElement).getByText('turn 2')).toBeDefined()

    // And it stopped at the oldest, rather than asking again for a page that
    // does not exist.
    expect(handle?.snapshot.hasMore).toBe(false)
  })

  it('refreshes a push provider, with no timer and no provider branch in the UI', async () => {
    // Held on an object rather than a `let`, so the assignment made inside the
    // provider's callback is visible to the assertion below it.
    const push: { notify?: () => void } = {}
    const adapter = conversationAdapter({
      // Active, or the runtime correctly refuses to subscribe: a finished
      // conversation is not one to keep asking about.
      conversations: [
        {
          id: 'thread-1',
          activity: 'active',
          items: [
            userMessage('u1', 'do the thing'),
            toolItem('t1', { name: 'shell', category: 'command', summary: 'ls -la' }),
            toolItem('t2', { name: 'view', category: 'read', summary: '/etc/hosts' }),
            assistantMessage('a1', 'done'),
          ],
        },
      ],
      refresh: {
        kind: 'push',
        sourceKey: (context, conversationId) => `${context}:${conversationId}`,
        subscribe: (_context, _conversationId, onChange) => {
          push.notify = onChange
          return () => undefined
        },
      },
    })
    render(<Harness adapter={adapter} />)
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2))

    // The provider appends, then says so — the same runtime, the same snapshot,
    // the same renderer the polling provider uses.
    adapter.replaceItems('thread-1', [
      userMessage('u1', 'do the thing'),
      toolItem('t1', { name: 'shell', category: 'command', summary: 'ls -la' }),
      toolItem('t2', { name: 'view', category: 'read', summary: '/etc/hosts' }),
      assistantMessage('a1', 'done'),
      userMessage('u2', 'and again'),
    ])
    expect(push.notify).toBeDefined()
    push.notify?.()

    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(3))
  })

  it('marks the trailing assistant message when the provider says the page is partial', async () => {
    render(<Harness adapter={conversationAdapter({ partialTail: true })} />)

    await waitFor(() => expect(screen.getByTestId('conversation-tool-group')).toBeDefined())
    const bodies = screen.getAllByTestId('conversation-assistant-body')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.dataset.streaming).toBe('true')
  })

  it('follows the status the provider states, not only the page’s partial tail', async () => {
    // SC-12 asks for streaming -> settled to be proven from a provider that can
    // *state* it, and SC-19 for the transition to be stable. Claude Code cannot
    // state one, which is why the page-level inference exists — but a provider
    // that does state it has to be believed, or the shared renderer is Claude's
    // renderer wearing the shared contract.
    const push: { notify?: () => void } = {}
    const adapter = new SyntheticAdapter({
      conversations: [
        {
          id: 'thread-1',
          activity: 'active',
          items: [userMessage('u1', 'do the thing'), assistantMessage('a1', 'wor', 'streaming')],
        },
      ],
      bindingId: 'thread-1',
      // Deliberately false: the provider is stating per-message status, and the
      // test would pass for the wrong reason if both signals agreed.
      partialTail: false,
      refresh: {
        kind: 'push',
        sourceKey: (context, conversationId) => `${context}:${conversationId}`,
        subscribe: (_context, _conversationId, onChange) => {
          push.notify = onChange
          return () => undefined
        },
      },
    })

    render(<Harness adapter={adapter} />)
    await waitFor(() => expect(screen.getByTestId('conversation-assistant-body')).toBeDefined())

    const body = () => screen.getByTestId('conversation-assistant-body')
    const first = body()
    expect(first.dataset.streaming).toBe('true')
    expect(first.textContent).toBe('wor')

    // Still streaming, more text — the same row, grown, not a second one.
    adapter.replaceItems('thread-1', [
      userMessage('u1', 'do the thing'),
      assistantMessage('a1', 'working on', 'streaming'),
    ])
    push.notify?.()
    await waitFor(() => expect(body().textContent).toBe('working on'))
    expect(body()).toBe(first)
    expect(body().dataset.streaming).toBe('true')

    // Settled. The provider says so, and the presentation follows it.
    adapter.replaceItems('thread-1', [
      userMessage('u1', 'do the thing'),
      assistantMessage('a1', 'working on it — done', 'settled'),
    ])
    push.notify?.()
    await waitFor(() => expect(body().textContent).toBe('working on it — done'))
    expect(body()).toBe(first)
    expect(body().dataset.streaming).toBeUndefined()
    // One row throughout, never two.
    expect(screen.getAllByTestId('conversation-assistant-body')).toHaveLength(1)
  })

  it('keeps a list failure out of the thread the reader is reading', async () => {
    // SC-11: the list and the open thread fail independently. A refresh the
    // reader did not ask for, about a pane they are not looking at, must not
    // replace the conversation they are in with an error surface.
    let handle: AIConversationHandle | undefined
    const adapter = conversationAdapter()
    render(<Harness adapter={adapter} onReady={(value) => (handle = value)} />)
    await waitFor(() => expect(screen.getByTestId('conversation-open')).toBeDefined())

    const turnsBefore = screen.getAllByTestId('conversation-turn').length

    adapter.failList = true
    act(() => handle?.reload())
    await waitFor(() =>
      expect(adapter.calls.filter((call) => call.kind === 'list').length).toBeGreaterThan(1),
    )

    // The thread is untouched: still open, still the same rows.
    expect(screen.getByTestId('conversation-open')).toBeDefined()
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(turnsBefore)
    // And nothing replaced it with a failure about something else.
    expect(screen.queryByTestId('conversation-error')).toBeNull()
  })

  it('rebinds a push provider when same-space refresh-source identity changes', async () => {
    const subscribed: string[] = []
    const unsubscribed: string[] = []
    const adapter = conversationAdapter({
      key: 'same-space',
      conversations: [
        {
          id: 'thread-1',
          activity: 'active',
          items: [userMessage('u1', 'hello'), assistantMessage('a1', 'hi')],
        },
      ],
      refresh: {
        kind: 'push',
        sourceKey: (context, conversationId) => `${context}:${conversationId}`,
        subscribe: (context, _conversationId, _onChange) => {
          subscribed.push(context)
          return () => unsubscribed.push(context)
        },
      },
    })

    const view = render(<Harness adapter={adapter} context="lease-a" />)
    await waitFor(() => expect(screen.getByTestId('conversation-open')).toBeDefined())

    view.rerender(<Harness adapter={adapter} context="lease-b" />)
    await waitFor(() => expect(subscribed).toEqual(['lease-a', 'lease-b']))

    expect(unsubscribed).toEqual(['lease-a'])
    expect(screen.getByTestId('conversation-open')).toBeDefined()
  })

  it('reconciles a changed overlap from an older page through the shared runtime', async () => {
    let handle: AIConversationHandle | undefined
    const adapter = new SyntheticAdapter({
      conversations: [
        {
          id: 'thread-1',
          activity: 'inactive',
          items: [
            userMessage('u0', 'before'),
            toolItem('t1', { status: 'running', output: null }),
            assistantMessage('a1', 'waiting'),
          ],
        },
      ],
      bindingId: 'thread-1',
      pageSize: 2,
      olderOverlap: 1,
      refresh: { kind: 'manual' },
    })

    render(<Harness adapter={adapter} onReady={(value) => (handle = value)} />)
    await waitFor(() => expect(handle?.snapshot.items.map((item) => item.id)).toEqual(['t1', 'a1']))

    adapter.replaceItems('thread-1', [
      userMessage('u0', 'before'),
      toolItem('t1', {
        status: 'success',
        output: { text: 'done', kind: 'text', truncated: false },
      }),
      assistantMessage('a1', 'waiting'),
    ])
    act(() => {
      handle?.loadOlder()
    })

    await waitFor(() => expect(handle?.snapshot.items.map((item) => item.id)).toEqual(['u0', 't1', 'a1']))
    expect(handle?.snapshot.items[1]).toMatchObject({ id: 't1', status: 'success' })
  })

  it('lets the reader choose instead of guessing, and says what it skipped', async () => {
    render(<Harness adapter={conversationAdapter({ bindingId: null, skipped: 2 })} />)

    await waitFor(() => expect(screen.getByTestId('conversation-candidate-title')).toBeDefined())
    // No binding is not an ambiguity to repair: the list is shown and nothing
    // is opened.
    expect(screen.getByTestId('conversation-nothing-open')).toBeDefined()
    expect(screen.queryByTestId('conversation-open')).toBeNull()

    await userEvent.click(screen.getByTestId('conversation-candidate-title'))
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2))
    expect(screen.getByTestId('conversation-skipped').textContent).toContain('2 records not shown')
  })
})
