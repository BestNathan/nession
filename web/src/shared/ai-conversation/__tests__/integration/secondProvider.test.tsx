import { render, screen, waitFor, within } from '@testing-library/react'
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
}: {
  adapter: AIConversationAdapter<string>
  onReady?: (handle: AIConversationHandle) => void
}) {
  const handle = useAIConversation(adapter, 'scope:one')
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

  it('pages backwards through the provider it was given', async () => {
    let handle: AIConversationHandle | undefined
    const adapter = new SyntheticAdapter({
      conversations: [
        { id: 'thread-1', activity: 'inactive', items: [userMessage('u1', 'one')] },
      ],
      bindingId: 'thread-1',
      pageSize: 1,
    })
    // Ten items, one per page: enough that older pages exist.
    adapter.replaceItems(
      'thread-1',
      Array.from({ length: 3 }, (_, index) => userMessage(`u${index}`, `turn ${index}`)),
    )

    render(<Harness adapter={adapter} onReady={(value) => (handle = value)} />)
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(1))

    expect(handle?.snapshot.hasMore).toBe(true)
    handle?.loadOlder()
    await waitFor(() => expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2))

    // Oldest first, and the prepend did not reorder what was already there.
    const turns = screen.getAllByTestId('conversation-turn')
    expect(within(turns[1] as HTMLElement).getByText('turn 2')).toBeDefined()
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
        subscribe: (onChange) => {
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
