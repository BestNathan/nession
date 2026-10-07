import { describe, expect, it, vi } from 'vitest'
import { ConversationRuntime } from '../../runtime/ConversationRuntime'
import {
  SyntheticAdapter,
  flush,
  manualScheduler,
  type SyntheticAdapterOptions,
} from '../fixtures/syntheticAdapter'
import { assistantMessage, toolItem, transcript, userMessage } from '../fixtures/items'

/**
 * A provider whose context carries a fact the key does not.
 *
 * The contract's `contextKey` says two contexts are the same conversation space;
 * it does not say the objects are equal. A token, a lease or a client handle is
 * a request fact that can change without redefining the space, and a provider
 * that reports a constant key is how the difference becomes observable — with
 * Claude's `{agentId, sessionId}` every field is in the key, so Claude cannot
 * show this at all (`#1363` round 4).
 */
function sameKeySetup(overrides: Partial<SyntheticAdapterOptions> = {}) {
  const adapter = new SyntheticAdapter({
    conversations: [{ id: 'c1', title: 'First', activity: 'active', items: transcript(6) }],
    bindingId: 'c1',
    pageSize: 3,
    refresh: { kind: 'manual' },
    key: 'space-1',
    ...overrides,
  })
  const runtime = new ConversationRuntime<string>(adapter)
  return { adapter, runtime }
}

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

describe('ConversationRuntime — a context whose value moves without its key', () => {
  it('replaces what later reads are asked with, without resetting the space', async () => {
    const { runtime, adapter } = sameKeySetup()
    runtime.setContext('token-a')
    await flush()
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5'])

    const lists = () => adapter.calls.filter((call) => call.kind === 'list').length
    const before = lists()

    // The same space, a new request fact. This is not a new conversation space,
    // so nothing the reader can see may move.
    runtime.setContext('token-b')
    await flush()
    expect(runtime.getSnapshot().openId).toBe('c1')
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5'])
    // Not even a re-list: a key that did not change is not a reason to read the
    // directory again, and pretending otherwise would refetch on every render.
    expect(lists()).toBe(before)

    // But every *later* call carries the newer context. This is the half that
    // was broken: `this.context` is what the adapter is handed, and it was only
    // ever replaced by a key change, so a provider could poll forever with the
    // context it had already replaced.
    runtime.reload()
    await flush()
    const reads = adapter.calls.filter((call) => call.kind === 'read')
    expect(reads[reads.length - 1]?.context).toBe('token-b')
  })

  it('still resets the whole space when the key does move', async () => {
    // The other half of the distinction, asserted here so the branch above
    // cannot be "fix" by never resetting: a different key must still drop the
    // selection, the items and both cursors.
    const adapter = new SyntheticAdapter({
      conversations: [
        { id: 'c1', items: transcript(2, 'a') },
        { id: 'c2', items: transcript(2, 'b') },
      ],
      bindingFor: (context) => (context === 'space-1' ? 'c1' : 'c2'),
      pageSize: 3,
      refresh: { kind: 'manual' },
    })
    const runtime = new ConversationRuntime<string>(adapter)
    // No `key` override, so the context *is* the key — the ordinary provider.
    runtime.setContext('space-1')
    await flush()
    expect(ids(runtime)).toEqual(['a0', 'a1'])

    runtime.setContext('space-2')
    await flush()
    expect(runtime.getSnapshot().openId).toBe('c2')
    expect(ids(runtime)).toEqual(['b0', 'b1'])
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

  it('keeps the cursor and the window when a page answers not-ready', async () => {
    // A thrown read is not the same as a read that answered. The throw is
    // covered above; this is the *answer*, which is a statement about the
    // conversation rather than about the transport — and until now the runtime
    // never looked at it, so `error` / `not_found` / `unavailable` all arrived
    // as a page with no items and no cursor, which is exactly the shape of
    // "this was the end of the history".
    const { runtime, adapter } = setup()
    runtime.setContext('a:s1')
    await flush()
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5'])
    expect(runtime.getSnapshot().hasMore).toBe(true)

    const older = () => adapter.calls.filter((call) => call.kind === 'read' && call.cursor)
    const asked = older().length
    adapter.forcedOlder = { state: 'error', error: 'cursor page could not be read' }

    expect(runtime.loadOlder()).toBe(true)
    await flush()

    const failed = runtime.getSnapshot()
    // The window is untouched, and the failure is visible rather than being
    // reported as the end of history.
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5'])
    expect(failed.hasMore).toBe(true)
    expect(failed.olderError).toBe('cursor page could not be read')
    expect(failed.loadingOlder).toBe(false)
    expect(failed.threadError).toBeNull()

    // Retry asks for the same cursor. `hasMore` is only honest if the cursor it
    // promises is still the one behind the window.
    adapter.forcedOlder = null
    expect(runtime.loadOlder()).toBe(true)
    await flush()

    expect(older()).toHaveLength(asked + 2)
    expect(older()[asked]?.cursor).toBe(older()[asked + 1]?.cursor)
    expect(ids(runtime)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    expect(runtime.getSnapshot().olderError).toBeNull()
    expect(runtime.getSnapshot().hasMore).toBe(false)
  })

  it('names a non-ready cursor page in the provider’s words when it has any', async () => {
    // `applyNewest` prefers the provider's message for the newest page; the
    // cursor path had no opinion at all because it had no branch. The fallbacks
    // are per state, because "the conversation is gone" and "the provider
    // cannot say right now" are the same *handling* but not the same sentence.
    const { runtime, adapter } = setup()
    runtime.setContext('a:s1')
    await flush()

    adapter.forcedOlder = { state: 'unavailable' }
    runtime.loadOlder()
    await flush()
    expect(runtime.getSnapshot().olderError).toBe('Older messages cannot be read right now')

    adapter.forcedOlder = { state: 'not_found' }
    runtime.loadOlder()
    await flush()
    expect(runtime.getSnapshot().olderError).toBe('This conversation is no longer there')
    // Still retryable: neither answer is the end of the history.
    expect(runtime.getSnapshot().hasMore).toBe(true)
  })
})

describe('ConversationRuntime — a provider slower than the poll', () => {
  it('coalesces the ticks instead of letting each one supersede the last', async () => {
    // The liveness bug the generation guard became. With a read slower than the
    // interval, every tick bumped the generation and superseded the answer the
    // previous tick was still waiting on, so no answer could ever land and an
    // active conversation froze on its first page while requests continued
    // forever. The guard is right for genuinely superseded work; it is not a
    // cancellation policy, and a timer must not be able to invalidate every
    // answer before it arrives.
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5'])

    const reads = () => adapter.calls.filter((call) => call.kind === 'read').length
    const before = reads()

    // Every read this burst starts is held, because that is what "slower than
    // the interval" means: holding only the first would let the later ticks
    // answer themselves, and the old code would have looked healthy.
    const held = [adapter.hold('read'), adapter.hold('read'), adapter.hold('read'), adapter.hold('read')]
    for (let tick = 0; tick < 4; tick += 1) {
      clock.tick()
      await flush()
    }

    // One read out, four ticks elapsed. The count is the assertion: fanning out
    // one request per tick is the defect, and it is invisible in the snapshot
    // until the answers start landing.
    expect(reads() - before).toBe(1)

    // The provider moves on while the read is out. The answer already in flight
    // was computed before this, so it cannot describe it — which is exactly why
    // the follow-up exists, and why "drop the notifications while a read is
    // out" would be wrong: the change would be lost rather than coalesced.
    adapter.replaceItems('c1', transcript(9))
    for (const release of held) {
      release()
    }
    await flush()

    // The new data reached the snapshot — the liveness half — and the three
    // ticks that joined the read cost exactly one more request.
    //
    // This is the assertion the old code cannot satisfy: all four of its reads
    // were issued before the change, so its last-applied page is the six-item
    // one and the change is simply never seen. The older window is kept, which
    // is what a newest page arriving does.
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8'])
    expect(reads() - before).toBe(2)
  })

  it('hands the slot to a reader’s reload instead of coalescing into it', async () => {
    // The dividing line, asserted rather than left to the comment: a tick is
    // passive and waits its turn, a reload is the reader asking *now*. Joining
    // the poll's read would answer them with a request that started before they
    // asked — and then one more — which is later than they meant.
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()

    const releasePoll = adapter.hold('read')
    clock.tick()
    await flush()

    adapter.replaceItems('c1', transcript(9))
    runtime.reload()
    await flush()

    // The reload's own read answered, so the newer transcript is on screen
    // before the slow tick has said anything at all.
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8'])

    // And the superseded answer lands into nothing: a read that lost its claim
    // cannot roll the window back to the state it was asked about.
    releasePoll()
    await flush()
    expect(ids(runtime)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8'])
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
        sourceKey: (context, conversationId) => `${context}:${conversationId}`,
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
        sourceKey: (context, conversationId) => `${context}:${conversationId}`,
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

  it('does not start a second page while one is already on its way', async () => {
    // #1363 round 3. The cursor does not move until the page lands, so a second
    // call would re-read the *same* one and then invalidate the first through
    // the generation counter — a wasted round trip that flickers the loader.
    const { runtime, adapter } = setup()
    runtime.setContext('a:s1')
    await flush()

    // Both answer `true`: a page is coming, which is what the scroll
    // controller's anchor decision asks. Only one of them starts it.
    expect(runtime.loadOlder()).toBe(true)
    expect(runtime.loadOlder()).toBe(true)
    await flush()

    const cursorReads = adapter.calls.filter(
      (call) => call.kind === 'read' && call.cursor !== undefined,
    )
    expect(cursorReads).toHaveLength(1)
  })

  it('asks for the next page again once the last one has landed', async () => {
    // The guard must not latch: a reader who keeps pulling gets page after page.
    // Nine items at three per page, because the default six is only *two* pages
    // and a second pull would have nothing to ask for — which is what this
    // asserted the first time, wrongly.
    const { runtime, adapter } = setup({
      conversations: [{ id: 'c1', title: 'First', activity: 'active', items: transcript(9) }],
    })
    runtime.setContext('a:s1')
    await flush()

    runtime.loadOlder()
    await flush()
    runtime.loadOlder()
    await flush()

    const cursorReads = adapter.calls.filter(
      (call) => call.kind === 'read' && call.cursor !== undefined,
    )
    expect(cursorReads.length).toBeGreaterThan(1)
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

  /**
   * A readable thread, then a poll whose *answer* is something other than
   * `ready`.
   *
   * Written once and used by all three, because the defect was a missing branch
   * — `applyNewest` returned before `syncRefresh()` for every non-ready state —
   * so covering one of the three would leave the other two unproven.
   */
  async function answersNonReady(state: 'not_found' | 'unavailable' | 'error') {
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()
    expect(clock.armed()).toBe(1)

    adapter.forcedReadState = state
    clock.tick()
    await flush()

    return { snapshot: runtime.getSnapshot(), armed: clock.armed() }
  }

  it('stops refreshing when a re-read answers not_found', async () => {
    const { snapshot, armed } = await answersNonReady('not_found')
    expect(snapshot.state).toBe('not_found')
    expect(armed).toBe(0)
  })

  it('stops refreshing when a re-read answers unavailable', async () => {
    // The one that matters most in practice: a provider that cannot say is not
    // a provider that will say something different on the next tick, so an
    // armed timer only repeats the question.
    const { snapshot, armed } = await answersNonReady('unavailable')
    expect(snapshot.state).toBe('unavailable')
    expect(armed).toBe(0)
  })

  it('stops refreshing when a re-read answers error', async () => {
    const { snapshot, armed } = await answersNonReady('error')
    expect(snapshot.state).toBe('error')
    expect(armed).toBe(0)
  })

  it('keeps the readable thread and the cadence when a poll throws', async () => {
    // The deliberate other half of the three above. A thrown failure says
    // nothing about the conversation — it is the transport, not the provider —
    // so the reader keeps the transcript they had and the runtime keeps asking.
    // Collapsing these two into one behaviour either freezes live conversations
    // or abandons conversations that were only briefly unreachable.
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()
    const readable = ids(runtime)
    expect(readable.length).toBeGreaterThan(0)

    adapter.failRead = true
    clock.tick()
    await flush()

    expect(runtime.getSnapshot().state).toBe('ready')
    expect(ids(runtime)).toEqual(readable)
    expect(clock.armed()).toBe(1)
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


describe('ConversationRuntime — round 6 contract boundaries', () => {
  it.each(['unavailable', 'error'] as const)(
    'keeps an auto-bound readable thread when the list answers %s',
    async (state) => {
      const { runtime, adapter } = setup()
      runtime.setContext('a:s1')
      await flush()
      const before = ids(runtime)

      adapter.forcedListState = state
      runtime.reload()
      await flush()

      const snapshot = runtime.getSnapshot()
      expect(snapshot.listState).toBe(state)
      expect(snapshot.openId).toBe('c1')
      expect(ids(runtime)).toEqual(before)
      expect(snapshot.conversations).toHaveLength(1)
    },
  )

  it('walks the canonical list cursor until the whole directory is loaded', async () => {
    const conversations = Array.from({ length: 5 }, (_, index) => ({
      id: `c${index}`,
      title: `Conversation ${index}`,
      items: transcript(1, `c${index}-`),
    }))
    const { runtime, adapter } = setup({
      conversations,
      bindingId: 'c0',
      listPageSize: 2,
      refresh: { kind: 'manual' },
    })

    runtime.setContext('a:s1')
    await flush()

    expect(runtime.getSnapshot().conversations.map((item) => item.id)).toEqual([
      'c0',
      'c1',
      'c2',
      'c3',
      'c4',
    ])
    expect(
      adapter.calls.filter((call) => call.kind === 'list').map((call) => call.cursor),
    ).toEqual([undefined, '2', '4'])
  })

  it('re-arms a push source only when its stable source identity changes', async () => {
    const subscriptions: string[] = []
    const unsubscribed: string[] = []
    const { runtime } = sameKeySetup({
      refresh: {
        kind: 'push',
        sourceKey: (context, conversationId) => `${context}:${conversationId}`,
        subscribe: (context) => {
          subscriptions.push(context)
          return () => unsubscribed.push(context)
        },
      },
    })

    runtime.setContext('lease-a')
    await flush()
    runtime.setContext('lease-a')
    runtime.setContext('lease-b')
    await flush()

    // Equal source identity is a no-op even when setContext is called again;
    // changing the provider-owned source identity tears down exactly once.
    expect(subscriptions).toEqual(['lease-a', 'lease-b'])
    expect(unsubscribed).toEqual(['lease-a'])
  })

  it('genuinely re-arms after dispose when the context key is unchanged', async () => {
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()
    expect(clock.armed()).toBe(1)

    const listBefore = adapter.calls.filter((call) => call.kind === 'list').length
    const readBefore = adapter.calls.filter((call) => call.kind === 'read').length
    runtime.dispose()
    expect(clock.armed()).toBe(0)

    runtime.setContext('a:s1')
    await flush()

    expect(adapter.calls.filter((call) => call.kind === 'list')).toHaveLength(listBefore + 1)
    expect(adapter.calls.filter((call) => call.kind === 'read')).toHaveLength(readBefore + 1)
    expect(clock.armed()).toBe(1)
  })

  it('drops a queued passive refresh after the answer semantically stops refresh', async () => {
    const { runtime, adapter, clock } = setup()
    runtime.setContext('a:s1')
    await flush()

    const readsBefore = adapter.calls.filter((call) => call.kind === 'read').length
    const release = adapter.hold('read')
    adapter.setActivity('c1', 'inactive')

    clock.tick()
    clock.tick()
    release()
    await flush()

    expect(adapter.calls.filter((call) => call.kind === 'read')).toHaveLength(readsBefore + 1)
    expect(runtime.getSnapshot().activity).toBe('inactive')
    expect(clock.armed()).toBe(0)
  })

  it('does not expose ready-page metadata after a non-ready newest answer', async () => {
    const { runtime, adapter } = setup({ partialTail: true, skipped: 3 })
    runtime.setContext('a:s1')
    await flush()
    expect(runtime.getSnapshot()).toMatchObject({ partialTail: true, skipped: 3 })

    adapter.forcedReadState = 'unavailable'
    runtime.reload()
    await flush()

    expect(runtime.getSnapshot()).toMatchObject({
      state: 'unavailable',
      partialTail: false,
      skipped: 0,
    })
  })

  it('accumulates skipped records reported by an older page into the loaded window', async () => {
    const { runtime } = setup({
      refresh: { kind: 'manual' },
      skippedFor: (cursor) => (cursor === undefined ? 0 : 3),
    })
    runtime.setContext('a:s1')
    await flush()
    expect(runtime.getSnapshot().skipped).toBe(0)

    runtime.loadOlder()
    await flush()

    expect(runtime.getSnapshot().skipped).toBe(3)
  })
})
