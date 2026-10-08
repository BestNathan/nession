/**
 * A second provider that exists only to prove the shared contract is not
 * secretly shaped like Claude Code (#1363 SC-12).
 *
 * ## Why this is a fixture and not a mock
 *
 * A mock asserts that the code called the collaborator. This asserts the
 * opposite thing: that the *runtime* works for a provider whose protocol,
 * refresh mechanism and vocabulary are none of them Claude's. A test that
 * drives `ConversationRuntime` through this adapter and still gets paging,
 * streaming growth and refresh reconciliation is evidence the behaviour lives
 * in the runtime; the same test driving the Claude adapter would be evidence of
 * nothing, because both sides could be wrong together.
 *
 * It is deliberately small. It implements the contract the way a real provider
 * would — pages by cursor, a binding, an activity that changes — and stops.
 * Anything it does not need to be, it is not: making it a faithful provider
 * would be re-introducing the coupling this exists to detect.
 *
 * ## Control
 *
 * Two things a test needs and a real network cannot give: the ability to hold a
 * request open across another request (`hold`), and the ability to see what was
 * asked for (`calls`). Both are here.
 */

import type {
  AIConversationAdapter,
  AIConversationListResult,
  AIConversationPage,
  AIRefreshPolicy,
} from '../../adapter/types'
import type {
  AIConversationActivity,
  AIConversationItem,
} from '../../model/conversation'

export interface SyntheticConversation {
  id: string
  title?: string | null
  preview?: string | null
  activity?: AIConversationActivity
  /** Oldest-first, the order the shared model uses. */
  items: AIConversationItem[]
}

export interface SyntheticAdapterOptions {
  conversations: SyntheticConversation[]
  /** The exact conversation this context is bound to; `null` for none. */
  bindingId?: string | null
  /**
   * The binding, per context.
   *
   * A provider whose binding moves with the context is the normal case, and it
   * is what lets a test tell one context's answer from another's.
   */
  bindingFor?: (context: string) => string | null
  /** Items per transcript page, for the pagination tests. */
  pageSize?: number
  /** Conversations per list page. Omitted means the directory fits in one page. */
  listPageSize?: number
  /** Let a cursor page restate this many items already held, to exercise overlap. */
  olderOverlap?: number
  refresh?: AIRefreshPolicy<string>
  /** Force the list's answer, whatever the data says. */
  listState?: AIConversationListResult['state']
  /** Force every read's answer, whatever the data says. */
  readState?: AIConversationPage['state']
  /** Make paged (cursor) reads reject, so pagination failure can be exercised. */
  failOlder?: boolean
  /** Report the newest page as ending mid-record, as a provider being appended to does. */
  partialTail?: boolean
  /** Records the adapter could not model, so the surface can say so. */
  skipped?: number
  /** Per-page skipped count when a test needs newest and older pages to differ. */
  skippedFor?: (cursor?: string) => number
  /** Context key this adapter reports. Defaults to the context string itself. */
  key?: string
  /** Request-authority key. Defaults to the concrete context string. */
  requestKey?: (context: string) => string
  /** Stable id for one paged directory snapshot. */
  listingId?: string
  /** Override the listing id per request when a test needs a generation change. */
  listingIdFor?: (context: string, cursor?: string) => string
  /** Mark a continuation as stale so the runtime must restart page one. */
  restartListFor?: (context: string, cursor?: string) => boolean
}

export interface RecordedCall {
  kind: 'list' | 'read'
  /** Which context was asked about — the assertion a stale-response test needs. */
  context: string
  conversationId?: string
  cursor?: string
}

interface Gate {
  kind: 'list' | 'read'
  cursor?: string
  promise: Promise<void>
  release: () => void
  open: boolean
}

/** A promise whose settlement the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

export class SyntheticAdapter implements AIConversationAdapter<string> {
  readonly id = 'synthetic'
  readonly identity = { label: 'Synthetic' }

  /** Every request the runtime made, in order. */
  readonly calls: RecordedCall[] = []

  /**
   * Make list reads reject. Mutable rather than a constructor option because the
   * interesting case is a list that fails *after* a thread is open and readable —
   * a provider that never answered the list could not open one.
   */
  failList = false

  /** Force the list state from here on, after an initially readable directory. */
  forcedListState: AIConversationListResult['state'] | null = null

  /**
   * Force the state every read answers with from here on.
   *
   * Mutable rather than only the constructor option, for the same reason
   * `failList` is: the case worth testing is a thread that *was* readable and
   * then stopped being. A provider that never answered `ready` never had a
   * thread to lose, so a constructor-only knob cannot express the transition.
   */
  forcedReadState: AIConversationPage['state'] | null = null

  /**
   * Make every read reject, as a transport failure rather than an answer.
   *
   * The distinction this fixture exists to keep: a thrown read says nothing
   * about the conversation, while a non-`ready` *answer* says something. Mutable
   * for the same reason as the two above — the case worth testing is a poll that
   * fails after the thread was readable.
   */
  failRead = false

  /**
   * Force every *cursor* read to answer non-`ready`, carrying this message.
   *
   * The sibling of `failOlder`, and the distinction is the whole point: a
   * thrown read says nothing about the conversation, while a non-ready *answer*
   * says something about it — `error`, `not_found`, `unavailable`. Only the
   * thrown half had a fixture, so a runtime that folded a semantic failure into
   * "end of history" had nothing in this file that could tell it apart.
   *
   * Cursor-scoped rather than reusing `forcedReadState` because the failure has
   * to arrive on a transcript that was *readable* first: a provider that never
   * answered the newest page never had a window to lose.
   */
  forcedOlder: { state: AIConversationPage['state']; error?: string } | null = null

  private readonly options: SyntheticAdapterOptions
  private readonly gates: Gate[] = []

  constructor(options: SyntheticAdapterOptions) {
    this.options = options
  }

  contextKey(context: string): string {
    return this.options.key ?? context
  }

  requestKey(context: string): string {
    return this.options.requestKey?.(context) ?? context
  }

  get refresh(): AIRefreshPolicy<string> {
    return this.options.refresh ?? { kind: 'manual' }
  }

  /**
   * Hold the next call of `kind` open until the returned function is called.
   *
   * `cursor` narrows it to a page request, which is what lets a test start an
   * older-page fetch, run a poll to completion on top of it, and only then let
   * the older page land — the interleaving where #1190's bug lived.
   */
  hold(kind: 'list' | 'read', cursor?: string): () => void {
    const { promise, resolve } = deferred()
    const gate: Gate = { kind, cursor, promise, release: resolve, open: true }
    this.gates.push(gate)
    return () => {
      gate.open = false
      resolve()
    }
  }

  /**
   * Change what a conversation holds, as an appending transcript does.
   *
   * Between two held reads this is what makes the second answer different from
   * the first — the only way a test can tell which of two overlapping responses
   * the runtime actually applied.
   */
  replaceItems(conversationId: string, items: AIConversationItem[]): void {
    const conversation = this.options.conversations.find((c) => c.id === conversationId)
    if (conversation) {
      conversation.items = items
    }
  }

  setActivity(conversationId: string, activity: AIConversationActivity): void {
    const conversation = this.options.conversations.find((c) => c.id === conversationId)
    if (conversation) {
      conversation.activity = activity
    }
  }

  async list(context: string, cursor?: string): Promise<AIConversationListResult> {
    this.calls.push({ kind: 'list', context, cursor })
    await this.waitFor('list', cursor)
    if (this.failList) {
      throw new Error('the list could not be read')
    }

    if (this.options.restartListFor?.(context, cursor)) {
      return {
        state: 'error',
        conversations: [],
        bindingId: null,
        nextCursor: null,
        restart: true,
        error: 'the listing changed',
      }
    }

    const state = this.forcedListState ?? this.options.listState ?? 'ready'
    if (state !== 'ready') {
      return {
        state,
        conversations: [],
        bindingId: null,
        nextCursor: null,
        ...(state === 'error' ? { error: 'the list could not be read' } : {}),
      }
    }

    const size = this.options.listPageSize ?? this.options.conversations.length
    const start = cursor === undefined ? 0 : Number(cursor)
    const end = Math.min(this.options.conversations.length, start + size)
    return {
      state,
      conversations: this.options.conversations.slice(start, end).map((c) => ({
        id: c.id,
        title: c.title ?? null,
        preview: c.preview ?? null,
        activity: c.activity ?? 'unknown',
      })),
      bindingId: this.options.bindingFor
        ? this.options.bindingFor(context)
        : (this.options.bindingId ?? null),
      nextCursor: end < this.options.conversations.length ? String(end) : null,
      listingId:
        this.options.listingIdFor?.(context, cursor) ??
        this.options.listingId ??
        `synthetic:${this.contextKey(context)}`,
    }
  }

  async read(
    context: string,
    conversationId: string,
    cursor?: string,
  ): Promise<AIConversationPage> {
    this.calls.push({ kind: 'read', context, conversationId, cursor })
    if (this.failRead) {
      throw new Error('the conversation could not be read')
    }
    // The answer is computed *before* the gate, because that is what a real
    // provider does: the response describes the data at the moment it was
    // asked, not at the moment it arrives. A fixture that read the data after
    // the gate would make two overlapping requests return the same page, and a
    // test could then never tell which of them the runtime applied.
    const conversation = this.options.conversations.find((c) => c.id === conversationId)
    const forcedOlder = cursor === undefined ? null : this.forcedOlder
    const state =
      forcedOlder?.state ??
      this.forcedReadState ??
      this.options.readState ??
      (conversation ? 'ready' : 'not_found')
    if (state !== 'ready' || !conversation) {
      await this.waitFor('read', cursor)
      return { state, items: [], partialTail: false, skipped: 0, error: forcedOlder?.error }
    }
    const page = this.pageOf(conversation, cursor)
    await this.waitFor('read', cursor)
    if (this.options.failOlder && cursor !== undefined) {
      throw new Error('the page could not be read')
    }
    return {
      state: 'ready',
      conversation: {
        id: conversation.id,
        title: conversation.title ?? null,
        preview: conversation.preview ?? null,
        activity: conversation.activity ?? 'unknown',
      },
      activity: conversation.activity ?? 'unknown',
      items: page.items,
      nextCursor: page.nextCursor,
      partialTail: this.options.partialTail ?? false,
      skipped: this.options.skippedFor?.(cursor) ?? this.options.skipped ?? 0,
    }
  }

  /**
   * One page, walking backwards from the end.
   *
   * Cursors are `<endIndex>` — the index *before* the page, which is the
   * direction a real transcript API pages in: the newest page is the tail and
   * older continues downward.
   */
  private pageOf(
    conversation: SyntheticConversation,
    cursor?: string,
  ): { items: AIConversationItem[]; nextCursor: string | null } {
    const size = this.options.pageSize ?? conversation.items.length
    const requestedEnd = cursor === undefined ? conversation.items.length : Number(cursor)
    const end =
      cursor === undefined
        ? requestedEnd
        : Math.min(conversation.items.length, requestedEnd + (this.options.olderOverlap ?? 0))
    const start = Math.max(0, requestedEnd - size)
    const items = conversation.items.slice(start, end)
    return { items, nextCursor: start > 0 ? String(start) : null }
  }

  /**
   * Wait on the first open gate that matches, and consume it.
   *
   * Consuming on match is what makes several gates usable in one test: two
   * `hold('read')` calls gate the first and second read respectively, so a test
   * can let the *newer* response land before the older one — the order a
   * generation guard exists to survive, and the only order that can detect it
   * missing.
   */
  private async waitFor(kind: 'list' | 'read', cursor?: string): Promise<void> {
    const gate = this.gates.find(
      (g) => g.open && g.kind === kind && (g.cursor === undefined || g.cursor === cursor),
    )
    if (gate) {
      gate.open = false
      await gate.promise
    }
  }
}

/**
 * A scheduler a test drives by hand, so "it polls again" is an assertion rather
 * than a sleep.
 */
export function manualScheduler() {
  const handlers = new Set<() => void>()
  return {
    scheduler: {
      setInterval: (handler: () => void) => {
        handlers.add(handler)
        return handler
      },
      clearInterval: (handle: unknown) => {
        handlers.delete(handle as () => void)
      },
    },
    /** Run every armed interval once. */
    tick: () => {
      for (const handler of [...handlers]) {
        handler()
      }
    },
    /** How many intervals are armed — 0 means the refresh is stopped. */
    armed: () => handlers.size,
  }
}

/** Let every already-resolved promise chain settle. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
