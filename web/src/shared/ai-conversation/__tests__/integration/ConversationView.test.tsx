import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationView } from '../../components/ConversationView'
import { ConversationList } from '../../components/ConversationList'
import type { AIConversationSnapshot } from '../../runtime/ConversationRuntime'
import type { AIConversationSummary } from '../../model/conversation'
import { assistantMessage, transcript, userMessage } from '../fixtures/items'

function summary(overrides: Partial<AIConversationSummary> = {}): AIConversationSummary {
  return { id: 'c1', title: 'One', activity: 'unknown', ...overrides }
}

function snapshot(overrides: Partial<AIConversationSnapshot> = {}): AIConversationSnapshot {
  return {
    listState: 'ready',
    conversations: [],
    bindingId: null,
    openId: null,
    state: null,
    conversation: null,
    activity: null,
    items: [],
    hasMore: false,
    partialTail: false,
    skipped: 0,
    listLoading: false,
    threadLoading: false,
    loadingOlder: false,
    olderError: null,
    listError: null,
    threadError: null,
    ...overrides,
  }
}

describe('ConversationList', () => {
  it('ranks a row title, preview then time, and names the row by its title', () => {
    render(
      <ConversationList
        conversations={[summary({ title: 'A title', preview: 'where it got to' })]}
        openId={null}
        onSelect={() => undefined}
      />,
    )

    expect(screen.getByTestId('conversation-candidate-title').textContent).toBe('A title')
    expect(screen.getByTestId('conversation-candidate-preview').textContent).toBe('where it got to')
  })

  it('keeps the identity reachable even though a UUID is not what a row shows', () => {
    render(
      <ConversationList conversations={[summary({ id: 'uuid-1' })]} openId={null} onSelect={() => undefined} />,
    )

    expect(screen.getByTestId('conversation-candidate-title').getAttribute('title')).toBe('uuid-1')
  })

  it('reports a choice rather than deciding what it means', async () => {
    const onSelect = vi.fn()
    render(<ConversationList conversations={[summary({ id: 'c9' })]} openId={null} onSelect={onSelect} />)

    // The row does not navigate: that is what lets Peek and Workspace share it
    // while doing different things with the answer.
    await userEvent.click(screen.getByTestId('conversation-candidate-title'))
    expect(onSelect).toHaveBeenCalledWith('c9')
  })

  it('marks the open conversation without relying on colour alone', () => {
    render(
      <ConversationList conversations={[summary({ id: 'c1' })]} openId="c1" onSelect={() => undefined} />,
    )

    expect(screen.getByRole('button').getAttribute('aria-current')).toBe('true')
  })

  it('heads its date buckets', () => {
    render(
      <ConversationList
        conversations={[
          summary({ id: 'a', updatedAt: new Date().toISOString() }),
          summary({ id: 'b', updatedAt: '2020-01-01T00:00:00Z' }),
        ]}
        openId={null}
        onSelect={() => undefined}
      />,
    )

    const headings = screen.getAllByTestId('conversation-bucket').map((node) => node.textContent)
    expect(headings).toEqual(['Today', 'Older'])
  })

  it('leaves an undated conversation unheaded rather than calling it older', () => {
    render(<ConversationList conversations={[summary({ id: 'a' })]} openId={null} onSelect={() => undefined} />)

    // Filing it under "Older" would assert a recency nothing knows.
    expect(screen.queryAllByTestId('conversation-bucket')).toHaveLength(0)
    expect(screen.getByTestId('conversation-candidate-title')).toBeDefined()
  })
})

describe('ConversationView', () => {
  const onLoadOlder = () => false

  it('shows the list beside the detail and says so when nothing is open', () => {
    render(
      <ConversationView
        snapshot={snapshot({ conversations: [summary()] })}
        providerLabel="Claude"
        layout="master-detail"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(screen.getByTestId('conversation-master-detail')).toBeDefined()
    // Master-detail does not offer "back to the list": the list is already there.
    expect(screen.queryByTestId('conversation-show-list')).toBeNull()
    expect(screen.getByTestId('conversation-nothing-open')).toBeDefined()
    // `conversation-open` marks the detail pane, so it must be absent here —
    // a marker that says "a conversation is open" while none is would be worse
    // than no marker.
    expect(screen.queryByTestId('conversation-open')).toBeNull()
  })

  it('marks the detail pane once a conversation is open', () => {
    render(
      <ConversationView
        snapshot={snapshot({ conversations: [summary()], openId: 'c1', state: 'ready' })}
        providerLabel="Claude"
        layout="master-detail"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(screen.getByTestId('conversation-open')).toBeDefined()
    expect(screen.queryByTestId('conversation-nothing-open')).toBeNull()
  })

  it('tells an empty directory apart from a host that has none', () => {
    const { unmount } = render(
      <ConversationView
        snapshot={snapshot({ listState: 'ready', conversations: [], openId: null })}
        providerLabel="Claude"
        layout="master-detail"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
      />,
    )
    // The provider answered, and the answer is "nothing here" — which is a
    // different sentence, and different advice, from "this host cannot".
    expect(screen.getByTestId('conversation-not-found')).toBeDefined()
    unmount()

    render(
      <ConversationView
        snapshot={snapshot({ listState: 'unavailable', conversations: [], openId: null })}
        providerLabel="Claude"
        layout="master-detail"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
      />,
    )
    expect(screen.getByTestId('conversation-unavailable')).toBeDefined()
    expect(screen.queryByTestId('conversation-not-found')).toBeNull()
  })

  it('pushes the detail over the list on a narrow surface', () => {
    render(
      <ConversationView
        snapshot={snapshot({
          conversations: [summary()],
          openId: 'c1',
          state: 'ready',
          items: [userMessage('u1', 'hi'), assistantMessage('a1', 'hello')],
        })}
        providerLabel="Claude"
        layout="push"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(screen.getByTestId('conversation-push')).toBeDefined()
    // The same transcript as master-detail — the layout is composition, not a
    // second renderer.
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2)
    expect(screen.getByTestId('conversation-show-list')).toBeDefined()
  })

  it('returns to the conversation when one is chosen from the pushed list', async () => {
    const onSelect = vi.fn()
    render(
      <ConversationView
        snapshot={snapshot({
          conversations: [summary({ id: 'c1' })],
          openId: 'c1',
          state: 'ready',
          items: transcript(1),
        })}
        providerLabel="Claude"
        layout="push"
        onSelect={onSelect}
        onLoadOlder={onLoadOlder}
      />,
    )

    // "Which pane" and "which conversation is open" are different facts: a
    // reader who opened the list with "All conversations" and then picked
    // something must land on that conversation, not stay on the list.
    await userEvent.click(screen.getByTestId('conversation-show-list'))
    expect(screen.getByTestId('conversation-candidate-title')).toBeDefined()

    await userEvent.click(screen.getByTestId('conversation-candidate-title'))
    expect(onSelect).toHaveBeenCalledWith('c1')
    expect(screen.queryByTestId('conversation-candidate-title')).toBeNull()
    expect(screen.getByTestId('conversation-show-list')).toBeDefined()
  })

  it('names the provider as the assistant and states its liveness', () => {
    render(
      <ConversationView
        snapshot={snapshot({
          openId: 'c1',
          conversation: summary(),
          activity: 'inactive',
          items: transcript(2),
        })}
        providerLabel="Claude"
        layout="master-detail"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(screen.getAllByText('Claude').length).toBeGreaterThan(0)
    // `inactive` is a real, readable conversation that has finished — saying so
    // is the difference between "not live" and "broken".
    expect(screen.getByTestId('conversation-state').textContent).toBe('Finished')
  })

  it('speaks about a failed list rather than showing an empty one', () => {
    render(
      <ConversationView
        snapshot={snapshot({ listError: 'the host refused', conversations: [] })}
        providerLabel="Claude"
        layout="master-detail"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(screen.getByTestId('conversation-error').textContent).toContain('the host refused')
  })

  it('keeps the rows it has when a refresh fails, and says the refresh failed', () => {
    // The second half is what `#1363` round 4 found missing. This test already
    // proved the rows survive and that the *full-pane* error does not replace
    // them — both right — and stopped there, so `listError` could be populated
    // and drawn nowhere at all. A reader looking at a list that had just failed
    // to refresh could not tell it from one that had refreshed and not moved.
    render(
      <ConversationView
        snapshot={snapshot({ listError: 'refresh failed', conversations: [summary()] })}
        providerLabel="Claude"
        layout="master-detail"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
        onReload={() => undefined}
      />,
    )

    // Rows a reader can already see are worth more than a message about a
    // refresh that failed.
    expect(screen.getByTestId('conversation-candidate-title')).toBeDefined()
    expect(screen.queryByTestId('conversation-error')).toBeNull()

    // Bounded, in the list, and actionable — the shape older paging already
    // uses for the same situation.
    const notice = screen.getByTestId('conversation-list-error')
    expect(notice.textContent).toContain('refresh failed')
    expect(within(notice).getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('says nothing about the list when nothing failed', () => {
    // The complement, so the notice above is a state and not decoration: a
    // reader never sees a warning about a refresh that worked.
    render(
      <ConversationView
        snapshot={snapshot({ conversations: [summary()] })}
        providerLabel="Claude"
        layout="master-detail"
        onSelect={() => undefined}
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(screen.queryByTestId('conversation-list-error')).toBeNull()
  })
})
