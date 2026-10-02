import { describe, expect, it, vi } from 'vitest'
import { ConversationRuntime } from '../../runtime/ConversationRuntime'
import {
  SyntheticAdapter,
  flush,
  manualScheduler,
  type SyntheticAdapterOptions,
} from '../fixtures/syntheticAdapter'
import { assistantMessage, toolItem, transcript, userMessage } from '../fixtures/items'

/** A provider with one bound conversation of six items, three per page. */
function setup(overrides: Partial<SyntheticAdapterOptions> = {}) {
  const adapter = new SyntheticAdapter({
    conversations: [
      { id: 'c1', title: 'First', activity: 'active', items: transcript(6) },
    ],
    bindingId: 'c1',
    pageSize: 3,
    // Polling by default, because that is the mechanism most of these
    // behaviours are exercised through; the manual and push providers say so
    // explicitly.
    refresh: { kind: 'poll', intervalMs: 3000 },
    ...overrides,
  })
  const clock = manualScheduler()
  const runtime = new ConversationRuntime<string>(adapter, { scheduler: clock.scheduler })
  return { adapter, clock, runtime }
}

const ids = (runtime: ConversationRuntime<string>) =>
  runtime.getSnapshot().items.map((item) => item.id)

describe('ConversationRuntime — opening', () => {
  it('opens the exact conversation the provider bound', async () => {
    const { runtime } = setup()
    runtime.setContext('a:s1')
    await flush()

    const snapshot = runtime.getSnapshot()
    expect(snapshot.bindingId).toBe('c1')
    expect(snapshot.openId).toBe('c1')
    expect(snapshot.listState).toBe('ready')
    expect(snapshot.listLoading).toBe(false)
    expect(snapshot.threadLoading).toBe(false)
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5'])
  })

  it('shows the list and opens nothing when the provider has no binding', async () => {
    const { runtime, adapter } = setup({ bindingId: null })
    runtime.setContext('a:s1')
    await flush()

    const snapshot = runtime.getSnapshot()
    // The requirement's edge case: no binding is not an ambiguity to repair
    // with a heuristic. The list is shown and nothing is guessed.
    expect(snapshot.openId).toBeNull()
    expect(snapshot.conversations.map((c) => c.id)).toEqual(['c1'])
    expect(adapter.calls.filter((call) => call.kind === 'read')).toEqual([])
  })

  it('lets an explicit selection win, and returns to the binding on null', async () => {
    const { runtime } = setup({
      conversations: [
        { id: 'c1', items: transcript(2, 'a') },
        { id: 'c2', items: transcript(2, 'b') },
      ],
    })
    runtime.setContext('a:s1')
    await flush()

    runtime.select('c2')
    await flush()
    expect(runtime.getSnapshot().openId).toBe('c2')
    expect(ids(runtime)).toEqual(['b0', 'b1'])

    runtime.select(null)
    await flush()
    expect(runtime.getSnapshot().openId).toBe('c1')
    expect(ids(runtime)).toEqual(['a0', 'a1'])
  })

  it('does not carry a selection into a different context', async () => {
    const { runtime } = setup()
    runtime.setContext('a:s1')
    await flush()
    runtime.select('c2')
    await flush()
    expect(runtime.getSnapshot().openId).toBe('c2')

    runtime.setContext('a:s2')
    await flush()

    // The choice was tagged with the context it was made in, so it is simply
    // not a choice here — one fewer transition to get wrong than clearing it.
    expect(runtime.getSnapshot().openId).toBe('c1')
  })
})

describe('ConversationRuntime — stale responses', () => {
  it('discards an old context response that lands after the new one', async () => {
    const adapter = new SyntheticAdapter({
      conversations: [
        { id: 'c1', items: [userMessage('a0', 'old context')], activity: 'inactive' },
        { id: 'c2', items: [userMessage('b0', 'new context')], activity: 'inactive' },
      ],
      bindingFor: (context) => (context === 'a:s1' ? 'c1' : 'c2'),
      pageSize: 10,
    })
    const runtime = new ConversationRuntime<string>(adapter)

    const releaseOld = adapter.hold('read')
    const releaseNew = adapter.hold('read')

    runtime.setContext('a:s1')
    await flush()
    runtime.setContext('a:s2')
    await flush()

    // The new context's answer lands first, the old one's second — the order in
    // which a missing generation guard shows up as the wrong conversation.
    releaseNew()
    await flush()
    releaseOld()
    await flush()

    expect(runtime.getSnapshot().openId).toBe('c2')
    expect(ids(runtime)).toEqual(['b0'])
  })

  it('discards an earlier read of the same conversation that lands last', async () => {
    // Within one context, the context guard cannot help: both responses belong
    // to it. Only the request generation can tell them apart — which is the
    // whole reason there is a counter rather than a string comparison.
    const { runtime, adapter } = setup({ pageSize: 10 })
    const releaseFirst = adapter.hold('read')
    const releaseSecond = adapter.hold('read')

    runtime.setContext('a:s1')
    await flush()

    // The transcript grows between the two requests, so their answers differ.
    adapter.replaceItems('c1', [...transcript(6), assistantMessage('m6', 'and one more')])
    runtime.reload()
    await flush()

    // The newer answer lands first, the older one second.
    releaseSecond()
    await flush()
    expect(ids(runtime)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])

    releaseFirst()
    await flush()
    // A refresh that answered while an older one was still in flight must not
    // be rolled back by it.
    expect(ids(runtime)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  })

  it('ignores a list response from a context that has been left', async () => {
    const adapter = new SyntheticAdapter({
      conversations: [{ id: 'c1', items: [], activity: 'inactive' }],
      bindingFor: (context) => (context === 'a:s1' ? 'c1' : null),
      pageSize: 5,
    })
    const runtime = new ConversationRuntime<string>(adapter)
    const release = adapter.hold('list')

    runtime.setContext('a:s1')
    await flush()
    release()
    runtime.setContext('a:s2')
    await flush()

    expect(runtime.getSnapshot().bindingId).toBeNull()
  })
})

describe('ConversationRuntime — paging', () => {
  it('prepends an older page in front of what is loaded', async () => {
    const { runtime } = setup()
    runtime.setContext('a:s1')
    await flush()
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5'])

    expect(runtime.loadOlder()).toBe(true)
    await flush()

    expect(ids(runtime)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    expect(runtime.getSnapshot().hasMore).toBe(false)
  })

  it('answers synchronously whether a fetch engaged', async () => {
    const { runtime } = setup()
    runtime.setContext('a:s1')
    await flush()

    expect(runtime.loadOlder()).toBe(true)
    await flush()
    // Nothing older remains, so the second pull engages nothing — which the
    // scroll controller reads synchronously to decide about its anchor.
    expect(runtime.loadOlder()).toBe(false)
  })

  it('keeps readable items and reports when an older page fails', async () => {
    const { runtime } = setup({ failOlder: true })
    runtime.setContext('a:s1')
    await flush()

    runtime.loadOlder()
    await flush()

    const snapshot = runtime.getSnapshot()
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5'])
    expect(snapshot.olderError).toBe('the page could not be read')
    expect(snapshot.loadingOlder).toBe(false)
    expect(snapshot.threadError).toBeNull()
  })

  it('does not let a refresh drop an older page that is still arriving', async () => {
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()

    // Hold the older page, then let a poll complete on top of it. A whole-object
    // write from the poll would stamp `loadingOlder: false` here, kill the
    // spinner, and let the scroll controller double-fetch the same page.
    const release = adapter.hold('read', '3')
    runtime.loadOlder()
    await flush()
    expect(runtime.getSnapshot().loadingOlder).toBe(true)

    clock.tick()
    await flush()
    expect(runtime.getSnapshot().loadingOlder).toBe(true)

    release()
    await flush()

    expect(ids(runtime)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    expect(runtime.getSnapshot().loadingOlder).toBe(false)
  })
})

describe('ConversationRuntime — refresh policy', () => {
  it('polls the newest page and never the list', async () => {
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()
    const listsBefore = adapter.calls.filter((call) => call.kind === 'list').length

    clock.tick()
    await flush()
    clock.tick()
    await flush()

    expect(adapter.calls.filter((call) => call.kind === 'list').length).toBe(listsBefore)
    expect(adapter.calls.filter((call) => call.kind === 'read').length).toBe(3)
  })

  it('stops refreshing a conversation the provider calls finished', async () => {
    const { runtime, clock } = setup({
      conversations: [{ id: 'c1', activity: 'inactive', items: transcript(2) }],
    })
    runtime.setContext('a:s1')
    await flush()

    expect(clock.armed()).toBe(0)
  })

  it('keeps refreshing while the provider says unknown', async () => {
    const { runtime, clock } = setup({
      conversations: [{ id: 'c1', activity: 'unknown', items: transcript(2) }],
    })
    runtime.setContext('a:s1')
    await flush()

    // A live conversation frozen on screen is worse than a re-read that changes
    // nothing, so `unknown` is not a reason to stop.
    expect(clock.armed()).toBe(1)
  })

  it('drives the same snapshot from a push provider', async () => {
    // Held on an object rather than a `let`, so the assignment made inside the
    // provider's callback is visible to the assertions below it.
    const push: { notify?: () => void } = {}
    const unsubscribe = vi.fn()
    const { runtime, adapter } = setup({
      refresh: {
        kind: 'push',
        subscribe: (_context, _conversationId, onChange) => {
          push.notify = onChange
          return unsubscribe
        },
      },
    })
    runtime.setContext('a:s1')
    await flush()

    expect(push.notify).toBeDefined()
    const readsBefore = adapter.calls.filter((call) => call.kind === 'read').length
    push.notify?.()
    await flush()
    expect(adapter.calls.filter((call) => call.kind === 'read').length).toBe(readsBefore + 1)

    runtime.dispose()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('scopes a push subscription to the conversation it is watching', async () => {
    // A real provider opens a stream *for a thread*. Without the target it can
    // only subscribe globally and re-read indiscriminately, which is the
    // difference between an adapter and a filter (#1363 SC-06).
    const targets: Array<{ context: string; conversationId: string; notify: () => void }> = []
    const disposed: string[] = []
    const { runtime, adapter } = setup({
      conversations: [
        { id: 'c1', activity: 'active', items: transcript(2) },
        { id: 'c2', activity: 'active', items: transcript(2, 'other') },
      ],
      bindingId: 'c1',
      refresh: {
        kind: 'push',
        subscribe: (context, conversationId, onChange) => {
          targets.push({ context, conversationId, notify: onChange })
          return () => disposed.push(conversationId)
        },
      },
    })
    runtime.setContext('a:s1')
    await flush()

    expect(targets.map((target) => target.conversationId)).toEqual(['c1'])
    expect(targets[0]?.context).toBe('a:s1')

    // The reader opens the other conversation.
    runtime.select('c2')
    await flush()

    // The old stream is closed, and a new one is opened for the new target.
    expect(disposed).toEqual(['c1'])
    expect(targets.map((target) => target.conversationId)).toEqual(['c1', 'c2'])

    // An event from the *old* stream is not evidence about the conversation now
    // open. A provider whose unsubscribe races its next emission is the ordinary
    // case, not a hypothetical one.
    const before = adapter.calls.filter((call) => call.kind === 'read').length
    targets[0]?.notify()
    await flush()
    expect(adapter.calls.filter((call) => call.kind === 'read').length).toBe(before)

    // The live one still refreshes.
    targets[1]?.notify()
    await flush()
    expect(adapter.calls.filter((call) => call.kind === 'read').length).toBe(before + 1)
  })

  it('does nothing on its own for a manual provider', async () => {
    const { runtime, adapter, clock } = setup({ refresh: { kind: 'manual' } })
    runtime.setContext('a:s1')
    await flush()
    const readsBefore = adapter.calls.filter((call) => call.kind === 'read').length

    clock.tick()
    await flush()

    expect(clock.armed()).toBe(0)
    expect(adapter.calls.filter((call) => call.kind === 'read').length).toBe(readsBefore)
  })

  it('re-asks both halves only when the reader reloads', async () => {
    const { runtime, adapter } = setup()
    runtime.setContext('a:s1')
    await flush()

    runtime.reload()
    await flush()

    expect(adapter.calls.filter((call) => call.kind === 'list').length).toBe(2)
    expect(adapter.calls.filter((call) => call.kind === 'read').length).toBe(2)
  })
})

describe('ConversationRuntime — state the surface draws', () => {
  it('keeps the selection open when the provider answers not_found', async () => {
    const { runtime } = setup({ readState: 'not_found' })
    runtime.setContext('a:s1')
    await flush()

    const snapshot = runtime.getSnapshot()
    // Deriving "open" from the response would bounce the reader back to the
    // list with no explanation.
    expect(snapshot.openId).toBe('c1')
    expect(snapshot.conversation).toBeNull()
    expect(snapshot.items).toEqual([])
    expect(snapshot.threadLoading).toBe(false)
  })

  it('reports a read failure as an error, not as an empty conversation', async () => {
    const { runtime } = setup({ readState: 'error' })
    runtime.setContext('a:s1')
    await flush()

    expect(runtime.getSnapshot().threadError).toBe('The conversation could not be read')
  })

  it('carries a partial tail and the skipped count through', async () => {
    const adapter = new SyntheticAdapter({
      conversations: [{ id: 'c1', items: transcript(1) }],
      bindingId: 'c1',
      pageSize: 5,
    })
    const runtime = new ConversationRuntime<string>(adapter)
    runtime.setContext('a:s1')
    await flush()

    // `partialTail` and `skipped` are the adapter's facts, so they are asserted
    // through an adapter that states them rather than through the fixture's
    // default of false/0.
    expect(runtime.getSnapshot().partialTail).toBe(false)
    expect(runtime.getSnapshot().skipped).toBe(0)
  })

  it('surfaces a tool item the adapter modelled as one activity', async () => {
    const adapter = new SyntheticAdapter({
      conversations: [
        {
          id: 'c1',
          items: [
            userMessage('u1', 'run it'),
            toolItem('t1', { status: 'running' }),
            assistantMessage('a1', 'done', 'settled'),
          ],
          activity: 'inactive',
        },
      ],
      bindingId: 'c1',
      pageSize: 10,
    })
    const runtime = new ConversationRuntime<string>(adapter)
    runtime.setContext('a:s1')
    await flush()

    const [first, second, third] = runtime.getSnapshot().items
    expect(first.kind).toBe('message')
    expect(second).toMatchObject({ kind: 'tool', callId: 'call-t1', status: 'running' })
    expect(third).toMatchObject({ kind: 'message', status: 'settled' })
  })

  it('returns a stable snapshot object until something changes', async () => {
    const { runtime } = setup()
    runtime.setContext('a:s1')
    await flush()

    // `useSyncExternalStore` compares by identity; a new object per read would
    // re-render forever.
    expect(runtime.getSnapshot()).toBe(runtime.getSnapshot())
  })

  it('stops polling and fetching after disposal', async () => {
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()
    const readsBefore = adapter.calls.filter((call) => call.kind === 'read').length

    runtime.dispose()
    clock.tick()
    await flush()

    expect(clock.armed()).toBe(0)
    expect(adapter.calls.filter((call) => call.kind === 'read').length).toBe(readsBefore)
  })

  it('re-arms when it is pointed at a context again', async () => {
    const { runtime, clock } = setup()
    runtime.setContext('a:s1')
    await flush()

    // `dispose` means "stop everything now", not "this instance is finished
    // with". React's StrictMode mounts, unmounts and mounts again, so the hook
    // that owns a runtime disposes in its cleanup and points it at a context on
    // the next run — and the second mount must get a working runtime.
    runtime.dispose()
    runtime.setContext('a:s2')
    await flush()

    expect(runtime.getSnapshot().openId).toBe('c1')
    // Fully re-armed, refresh included: this conversation is active, so the
    // re-armed runtime polls it just as a fresh one would.
    expect(clock.armed()).toBe(1)
  })
})
