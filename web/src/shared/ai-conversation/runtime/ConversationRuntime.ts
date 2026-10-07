/**
 * The conversation state machine, with no React in it.
 *
 * ## What lives here
 *
 * Everything about *a conversation being open* that is not specific to who is
 * serving it: which one is open, what has been loaded, what is still loading,
 * what failed, what a late response is allowed to touch, and when to ask again.
 * Those questions have the same answers whether the transcript comes from
 * Claude Code, from a second provider, or from a fixture — which is why they
 * are here rather than in a provider's hook (#1363 SC-02).
 *
 * It is a plain class with `getSnapshot()` and `subscribe()`, so React consumes
 * it through `useSyncExternalStore` and tests consume it directly, in the node
 * project, with no DOM and no renderer. The behaviour worth proving — paging,
 * generation guards, reconciliation — is all reachable without a browser.
 *
 * ## The three things most likely to be broken by a well-meaning refactor
 *
 * 1. **Two generations, not one.** A refresh and an older-page fetch are in
 *    flight together. One counter would let either invalidate the other: the
 *    poll would drop a valid older page (#1190) or a page fetch would discard a
 *    newer poll.
 * 2. **`loadingOlder` belongs to the older fetch.** The refresh writes its
 *    result as a partial update precisely so it cannot stamp
 *    `loadingOlder: false` over an in-flight page — which would kill the
 *    spinner and let a second pull double-fetch the same page.
 * 3. **Cursor ownership.** The older cursor follows the newest page only while
 *    the reader has not paged back. Afterwards it is theirs, and a refresh
 *    leaves it alone.
 *
 * ## Selection is tagged, not reset
 *
 * An explicit choice records the context it was made in. A context change does
 * not clear it — a choice whose tag is not the current context simply is not a
 * choice, and the open conversation falls back to the provider's binding. That
 * is one fewer transition to get wrong, and it is what makes a Session change
 * unable to carry the previous Session's selection.
 */

import type { AIConversationAdapter, AIConversationPage } from '../adapter/types'
import type {
  AIConversationActivity,
  AIConversationItem,
  AIConversationListState,
  AIConversationReadState,
  AIConversationSummary,
} from '../model/conversation'
import {
  emptyPositions,
  hasOlder,
  itemsOf,
  skippedOf,
  withNewest,
  withOlderPage,
  type ConversationPositions,
} from './pagination'

/**
 * What the surface draws.
 *
 * The list half and the thread half are kept apart rather than merged into one
 * status, because they answer different questions and fail independently: a
 * directory that cannot be listed is not a conversation that cannot be read,
 * and the surface renders them in different places (#1222).
 */
export interface AIConversationSnapshot {
  /** The provider's own word for what it could answer about the directory. */
  listState: AIConversationListState | null
  /** What the reader may choose from. */
  conversations: AIConversationSummary[]
  /** The exact conversation the provider bound this context to, if any. */
  bindingId: string | null
  /**
   * Which conversation is open — the *selection*, not the response.
   *
   * They agree whenever a read succeeded, and this is the one that is still
   * true when it did not: a `not_found` carries no conversation, and deriving
   * "open" from the response would silently bounce the reader back to the list
   * with no explanation.
   */
  openId: string | null
  /**
   * The open conversation as one value a surface can key a subtree by.
   *
   * `openId` alone is not an identity. The adapter contract scopes a
   * conversation to a provider *and* a context, so two providers may both have
   * a conversation called `c1`, and the same provider may have a `c1` in two
   * contexts. A React `key` built from the id alone would then tell a surface
   * that two different conversations are the same one — and the state keyed
   * below it (scroll position, disclosure, focus) would cross between them
   * (`#1363` round 4).
   *
   * Composed here because the runtime is the only thing that holds all three
   * parts: the adapter it was built for, the context key, and the selection.
   * `null` when nothing is open — a surface still has to name that state, and
   * `'no-conversation'` is a different value from any real one.
   */
  conversationKey: string | null
  /**
   * The provider's own word for what it could answer about the open
   * conversation.
   *
   * Kept beside `error` rather than folded into it, because `not_found` and
   * `unavailable` are answers, not failures: SC-11 requires "this conversation
   * was deleted" and "this host cannot read that directory" to stay distinct
   * from "the read failed", and a surface that only had `error` would have to
   * infer which it was from a message string.
   */
  state: AIConversationReadState | null
  /** The open conversation's own description, from the read response. */
  conversation: AIConversationSummary | null
  /** Its liveness relative to the context — "Running now" / "Finished". */
  activity: AIConversationActivity | null
  /** Everything loaded, oldest first. */
  items: AIConversationItem[]
  /** Whether older items remain beyond what is loaded. */
  hasMore: boolean
  /** The transcript ended mid-record — normal for one being appended to. */
  partialTail: boolean
  /** Safe lower bound for records omitted somewhere in the loaded window. */
  skipped: number
  /**
   * Whether the *list* is being read.
   *
   * Loading and failure are per half, and they are four fields rather than two
   * for the same reason `state` sits beside `error`: the list and the open
   * thread fail independently, and a single collapsed pair lets either half's
   * bad news be shown as the other's. Measured before the split — a list
   * refresh failing while a readable thread was open replaced that thread with
   * a failure surface, because the transcript reads `error` and `error` was
   * whichever half had spoken last (#1363 SC-11).
   */
  listLoading: boolean
  /** Whether the *open thread* is being read. */
  threadLoading: boolean
  loadingOlder: boolean
  /** Older-page pagination failed while readable items remain (#1190). */
  olderError: string | null
  /** The list pane's failure. The list pane is the only thing that may show it. */
  listError: string | null
  /** The open thread's failure. The transcript is the only thing that may show it. */
  threadError: string | null
}

/**
 * Timers, injected so a test can drive the clock instead of waiting on it.
 *
 * The default is the global pair; the node and jsdom environments both have
 * them. A test that asserted "polling asks again" by sleeping for the interval
 * would be slow and flaky, and a runtime that could not be asked to tick would
 * make that the only option.
 */
export interface ConversationScheduler {
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const DEFAULT_SCHEDULER: ConversationScheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

interface ListState {
  state: AIConversationListState | null
  conversations: AIConversationSummary[]
  bindingId: string | null
  loading: boolean
  error: string | null
}

interface ThreadState {
  state: AIConversationReadState | null
  conversation: AIConversationSummary | null
  activity: AIConversationActivity | null
  partialTail: boolean
  loading: boolean
  loadingOlder: boolean
  olderError: string | null
  error: string | null
}

const EMPTY_LIST: ListState = {
  state: null,
  conversations: [],
  bindingId: null,
  loading: true,
  error: null,
}

const EMPTY_THREAD: ThreadState = {
  state: null,
  conversation: null,
  activity: null,
  partialTail: false,
  loading: true,
  loadingOlder: false,
  olderError: null,
  error: null,
}

const EMPTY_SNAPSHOT: AIConversationSnapshot = {
  listState: null,
  conversations: [],
  bindingId: null,
  openId: null,
  conversationKey: null,
  state: null,
  conversation: null,
  activity: null,
  items: [],
  hasMore: false,
  partialTail: false,
  skipped: 0,
  listLoading: true,
  threadLoading: false,
  loadingOlder: false,
  olderError: null,
  listError: null,
  threadError: null,
}

/**
 * Distinguishes one runtime from another, for as long as the page lives.
 *
 * A provider is identified by the *runtime*, not by its adapter object: the
 * hook builds a runtime per adapter and swaps them, so the same component can
 * be pointed at two providers in its lifetime. Two providers that share a
 * context key and an `openId` are still two different conversations, and
 * without this the key below could not tell them apart.
 */
let runtimeIdentities = 0

function nextRuntimeIdentity(): number {
  runtimeIdentities += 1
  return runtimeIdentities
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * What to tell the reader about a cursor page the provider would not send.
 *
 * The provider's own words win whenever it has any, exactly as `applyNewest`
 * prefers `page.error`. The fallbacks are per state because the states are not
 * interchangeable to the person reading them: "the conversation is gone" and
 * "the provider could not say right now" are the same *handling* here — keep
 * the cursor, offer Retry — but not the same sentence.
 */
function olderPageMessage(page: AIConversationPage): string {
  if (page.error) {
    return page.error
  }
  switch (page.state) {
    case 'not_found':
      return 'This conversation is no longer there'
    case 'unavailable':
      return 'Older messages cannot be read right now'
    default:
      return 'Unable to load older messages'
  }
}

export class ConversationRuntime<Context> {
  private readonly adapter: AIConversationAdapter<Context>
  private readonly scheduler: ConversationScheduler
  /** This runtime's part of a conversation's identity — see `conversationKey`. */
  private readonly identity = nextRuntimeIdentity()
  private readonly listeners = new Set<() => void>()
  private snapshot: AIConversationSnapshot = EMPTY_SNAPSHOT

  private context: Context | null = null
  private contextKey: string | null = null
  private chosen: { key: string; id: string } | null = null
  /** What the thread currently holds — the id the loaded items belong to. */
  private loadedId: string | null = null

  private list: ListState = EMPTY_LIST
  private thread: ThreadState = EMPTY_THREAD
  private positions: ConversationPositions = emptyPositions()

  /**
   * Three counters, one per independent request stream.
   *
   * They are separate for the same reason the generations are: these requests
   * overlap in time and must not invalidate each other. A single counter would
   * let `select()` — which is not a list event — discard an in-flight list
   * response, leaving the list stuck on its spinner.
   */
  private listGeneration = 0
  private newestGeneration = 0
  private olderGeneration = 0

  /**
   * The newest read holding the single-flight slot, by generation.
   *
   * Passive refresh is the *repeat* path, and repetition is what turned the
   * generation guard from a staleness rule into a liveness bug: a provider
   * slower than the poll interval is asked again before it answers, so every
   * answer is superseded before it can land and an active conversation freezes
   * on its first page while requests continue forever (`#1363` round 4). One
   * read at a time, plus at most one remembered follow-up, is what lets a slow
   * answer land instead of never landing.
   *
   * Kept as the generation rather than a boolean because the slot is released
   * by a *target* change without waiting for the read that held it — and that
   * read's settlement must not clear the claim its successor now owns.
   */
  private newestInFlight: number | null = null
  /**
   * A refresh asked for while a read was already out.
   *
   * A bit, not a queue: a refresh re-reads the newest page, so any number of
   * requests arriving while one is out are answered by a single later read —
   * the data it will see already includes what the intermediate answers would
   * have said. Dropping them instead would lose a change that arrived *after*
   * the in-flight read took its snapshot, which is the push case.
   */
  private newestPending = false
  private timer: unknown = null
  private unsubscribePush: (() => void) | null = null
  /**
   * What the running refresh is watching.
   *
   * A push stream is opened *for a conversation*, so "is a refresh running" is
   * not enough to know whether the right one is: a subscription left over from
   * a conversation the reader has left is still running, and still firing.
   * Holding the target is what lets both halves be wrong in a way the other
   * notices — the subscription knows what it was for, and an event from one that
   * no longer matches is not evidence about what is open now.
   */
  private refreshArmedFor: {
    key: string
    conversationId: string
    sourceKey: string | null
  } | null = null
  private disposed = false

  constructor(
    adapter: AIConversationAdapter<Context>,
    options: { scheduler?: ConversationScheduler } = {},
  ) {
    this.adapter = adapter
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER
  }

  /** The current state. Stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot(): AIConversationSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Point the runtime at a context — a Session, a directory, whatever the
   * provider's requests are scoped by. `null` clears it.
   *
   * A **different key** is a different conversation space: nothing about the
   * old one survives, not the items, not either cursor, not the binding. The
   * **same key with a different value** is the same space with new request
   * facts, and only the facts are replaced — see the branch below for why the
   * two cannot be the same statement.
   */
  setContext(context: Context | null): void {
    // `dispose` stops work but does not make the instance one-shot: React
    // StrictMode can dispose and point the same runtime at the same context
    // again. Remember that distinction before clearing the flag, because a
    // same-key remount must genuinely re-arm reads and refresh.
    const wasDisposed = this.disposed
    this.disposed = false
    const key = context === null ? null : this.adapter.contextKey(context)

    if (key !== null && key === this.contextKey) {
      this.context = context

      if (wasDisposed) {
        // Every pre-dispose response was invalidated by `dispose`; start fresh
        // requests without throwing away the readable window already on screen.
        void this.fetchList(key, ++this.listGeneration)
        if (this.loadedId !== null) {
          this.reloadNewest()
        }
      } else {
        // The space did not change, but a push source may have. The provider's
        // stable `sourceKey` decides whether the subscription is still valid;
        // object identity deliberately does not.
        this.syncRefresh()
      }
      return
    }

    this.context = context
    this.contextKey = key
    this.newestGeneration += 1
    this.olderGeneration += 1
    this.positions = emptyPositions()
    this.list = EMPTY_LIST
    this.thread = EMPTY_THREAD
    this.loadedId = null
    this.stopRefresh()
    this.emit()
    if (key === null) {
      return
    }
    const generation = ++this.listGeneration
    void this.fetchList(key, generation)
  }

  /**
   * Open a conversation the reader chose. `null` returns to the provider's
   * binding.
   */
  select(conversationId: string | null): void {
    if (this.disposed || this.contextKey === null) {
      return
    }
    this.chosen =
      conversationId === null ? null : { key: this.contextKey, id: conversationId }
    this.syncThread()
    this.emit()
  }

  /** Ask both halves again — the list's only refresh, by design (#1222). */
  reload(): void {
    if (this.disposed || this.contextKey === null) {
      return
    }
    const key = this.contextKey
    void this.fetchList(key, ++this.listGeneration)
    this.reloadNewest()
  }

  /**
   * Fetch the page before the loaded window.
   *
   * Returns *synchronously* whether a fetch actually engaged. The scroll
   * controller decides from that answer whether to keep its pending anchor:
   * reading `loadingOlder` later — even one microtask later — races React's
   * deferred flush of wheel-event renders and would disarm a fetch that is
   * genuinely on its way.
   */
  loadOlder(): boolean {
    const key = this.contextKey
    const cursor = this.positions.cursor
    if (this.disposed || key === null || cursor === null || this.context === null) {
      return false
    }
    // A page already on its way answers this call too. Two things make that the
    // right reading rather than a swallow:
    //
    // - the caller's question is "will more history arrive?", not "did this call
    //   start it" — `true` is what keeps the scroll controller's pending anchor,
    //   so returning `false` would disarm a fetch that is genuinely coming;
    // - the cursor does not move until the page lands, so a second fetch would
    //   re-read the *same* one and then invalidate the first through the
    //   generation counter — a wasted round trip that also flickers the loader.
    //
    // `loadingOlder` is set before `fetchOlder`'s first `await`, so it is already
    // true by the time this returns and the guard cannot miss a racing call.
    // `#1363` round 3.
    if (this.thread.loadingOlder) {
      return true
    }
    const id = ++this.olderGeneration
    void this.fetchOlder(key, cursor, id)
    return true
  }

  /** Stop every timer and subscription, and refuse further work. */
  dispose(): void {
    this.disposed = true
    this.listGeneration += 1
    this.newestGeneration += 1
    this.olderGeneration += 1
    this.newestInFlight = null
    this.newestPending = false
    this.stopRefresh()
    this.listeners.clear()
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The open conversation as one key, or `null` when nothing is open.
   *
   * Three parts, because two of them are not enough to be an identity: the
   * runtime (which provider), the context key (which conversation *space*),
   * and the id. See `AIConversationSnapshot.conversationKey`.
   */
  private conversationKey(openId: string | null): string | null {
    if (openId === null || this.contextKey === null) {
      return null
    }
    return `${this.identity}\u0000${this.contextKey}\u0000${openId}`
  }

  /** The selection if it belongs to this context, else the provider's binding. */
  private openId(): string | null {
    const selected = this.chosen !== null && this.chosen.key === this.contextKey
      ? this.chosen.id
      : null
    return selected ?? this.list.bindingId
  }

  /** Start, move or stop the thread when the open conversation changed. */
  private syncThread(): void {
    const openId = this.openId()
    if (openId === this.loadedId) {
      return
    }
    this.loadedId = openId
    this.newestGeneration += 1
    this.olderGeneration += 1
    // The read that held the slot was reading the conversation this just moved
    // away from, so it no longer holds anything: releasing it here is what lets
    // the new target's first read start now rather than queue behind an answer
    // nobody wants. Its own settlement checks the generation and leaves this
    // claim alone.
    this.newestInFlight = null
    this.newestPending = false
    this.positions = emptyPositions()
    this.thread = EMPTY_THREAD
    this.stopRefresh()
    if (openId === null || this.context === null) {
      return
    }
    // A failure a reader should act on arrives through a load they asked for;
    // the first read is one they asked for by opening the surface, so it
    // reports. The poll is the path that swallows (see `poll`).
    this.requestNewest(true)
  }

  private async fetchList(key: string, generation: number): Promise<void> {
    const context = this.context
    if (context === null) {
      return
    }

    try {
      const conversations: AIConversationSummary[] = []
      const seenConversations = new Set<string>()
      const seenCursors = new Set<string>()
      let bindingId: string | null = null
      let cursor: string | undefined

      for (;;) {
        const result = await this.adapter.list(context, cursor)
        if (!this.wanted(key, generation, this.listGeneration)) {
          return
        }

        // A semantic non-ready answer describes the directory request, not the
        // validity of facts already loaded from it. Preserve those facts — in
        // particular the exact binding that keeps an auto-bound readable thread
        // open — and expose only the changed directory state.
        if (result.state !== 'ready') {
          this.list = {
            ...this.list,
            state: result.state,
            loading: false,
            error:
              result.state === 'error'
                ? (result.error ?? 'The conversations could not be listed')
                : null,
          }
          this.syncThread()
          this.emit()
          return
        }

        for (const conversation of result.conversations) {
          if (!seenConversations.has(conversation.id)) {
            seenConversations.add(conversation.id)
            conversations.push(conversation)
          }
        }
        bindingId ??= result.bindingId

        const next = result.nextCursor
        if (next === null) {
          break
        }
        if (seenCursors.has(next)) {
          throw new Error('Conversation list returned a repeated cursor')
        }
        seenCursors.add(next)
        cursor = next
      }

      this.list = {
        state: 'ready',
        conversations,
        bindingId,
        loading: false,
        error: null,
      }
      this.syncThread()
      this.emit()
    } catch (error) {
      if (!this.wanted(key, generation, this.listGeneration)) {
        return
      }
      this.list = {
        ...this.list,
        loading: false,
        error: message(error, 'Unable to list the conversations'),
      }
      this.emit()
    }
  }

  private async fetchNewest(
    conversationId: string,
    key: string,
    generation: number,
  ): Promise<void> {
    const context = this.context
    if (context === null) {
      return
    }
    this.applyNewest(await this.adapter.read(context, conversationId), key, generation)
  }

  private async fetchOlder(key: string, cursor: string, generation: number): Promise<void> {
    const context = this.context
    const conversationId = this.loadedId
    if (context === null || conversationId === null) {
      return
    }
    this.thread = { ...this.thread, loadingOlder: true, olderError: null }
    this.emit()
    try {
      const page = await this.adapter.read(context, conversationId, cursor)
      if (!this.wanted(key, generation, this.olderGeneration)) {
        return
      }
      // A cursor read has its own state, and "not ready" is not "no more
      // history".
      //
      // `withOlderPage` reads a missing `nextCursor` as the end of the window,
      // and a provider answering `error`, `not_found` or `unavailable` said
      // nothing of the kind — its `nextCursor` is absent because it has no page
      // to describe, not because there is no page. Feeding it through would
      // consume the cursor, clear `hasMore`, and report a silent end of history
      // to a reader whose history simply failed to load (#1363 round 4). So the
      // window and both cursors stay exactly as they were and only the reason is
      // recorded: every one of these is retryable, and Retry re-reads *this*
      // cursor because nothing moved it.
      if (page.state !== 'ready') {
        this.thread = {
          ...this.thread,
          loadingOlder: false,
          olderError: olderPageMessage(page),
        }
        this.emit()
        return
      }
      this.positions = withOlderPage(this.positions, page)
      this.thread = { ...this.thread, loadingOlder: false, olderError: null }
    } catch (error) {
      if (!this.wanted(key, generation, this.olderGeneration)) {
        return
      }
      this.thread = {
        ...this.thread,
        loadingOlder: false,
        olderError: message(error, 'Unable to load the conversation'),
      }
    }
    this.emit()
  }

  /**
   * A newest page arrived: replace the page, keep everything behind it.
   *
   * Written as a partial update on purpose — this same path runs as the poll,
   * and a whole-object write would stamp `loadingOlder: false` over an
   * in-flight older page. The older fetch owns those fields and clears them
   * itself.
   */
  private applyNewest(page: AIConversationPage, key: string, generation: number): void {
    if (!this.wanted(key, generation, this.newestGeneration)) {
      return
    }
    if (page.state !== 'ready') {
      this.thread = {
        ...this.thread,
        state: page.state,
        conversation: page.conversation ?? null,
        activity: page.activity ?? null,
        partialTail: false,
        loading: false,
        error:
          page.state === 'error'
            ? (page.error ?? 'The conversation could not be read')
            : null,
      }
      // A non-ready answer ends the refresh, not merely this read. It is a
      // *semantic* answer — the provider said the conversation is gone, or that
      // it cannot say — so the reason the timer or subscription existed no
      // longer holds, and an armed one goes on polling a state whose only
      // remaining answers are the same. This is the deliberate opposite of a
      // thrown poll failure, which `poll()` swallows and retries precisely
      // because it says nothing about the conversation.
      this.syncRefresh()
      this.emit()
      return
    }
    this.positions = withNewest(this.positions, page)
    this.thread = {
      ...this.thread,
      state: page.state,
      conversation: page.conversation ?? null,
      activity: page.activity ?? null,
      partialTail: page.partialTail,
      loading: false,
      error: null,
    }
    this.syncRefresh()
    this.emit()
  }

  /**
   * The reader asked for the newest page, so this read supersedes rather than
   * joins.
   *
   * A tick is passive and coalesces (see `requestNewest`), but this one is not:
   * handing the reader an answer to a read that started *before* they asked,
   * then one more, is later than they meant. So the slot is handed over — the
   * read already out keeps its generation and loses its claim, and its answer is
   * discarded when it lands like any other superseded one.
   *
   * This is also the case the generation guard is still for. It was never wrong
   * about staleness; it was wrong as a *cancellation policy* driven by a timer.
   */
  private reloadNewest(): void {
    this.newestInFlight = null
    this.newestPending = false
    this.requestNewest(true)
  }

  /**
   * Ask for the newest page, at most one read at a time.
   *
   * The single-flight rule is what makes a provider slower than the poll
   * interval *late* rather than permanently frozen: without it every tick
   * supersedes the answer the previous tick is still waiting on, and no answer
   * can ever land. A request that arrives while a read is out is remembered as
   * one follow-up rather than started — a bit, because the follow-up re-reads
   * the newest page and so already includes what the ones it replaced would
   * have said.
   */
  private requestNewest(report: boolean): void {
    if (this.newestInFlight !== null) {
      this.newestPending = true
      return
    }
    this.startNewest(report)
  }

  private startNewest(report: boolean): void {
    const key = this.contextKey
    const openId = this.loadedId
    if (key === null || openId === null || this.context === null) {
      this.newestPending = false
      return
    }
    const generation = ++this.newestGeneration
    this.newestInFlight = generation
    this.newestPending = false
    void this.fetchNewest(openId, key, generation).then(
      () => this.settleNewest(generation),
      () => {
        if (report) {
          this.failNewest(key, generation)
        }
        this.settleNewest(generation)
      },
    )
  }

  /**
   * The slot is free again; run the one follow-up if anything asked.
   *
   * Guarded on the generation because a target change — or a reader's reload —
   * releases the slot without waiting for this read: by the time it settles,
   * `newestInFlight` may name its successor, and clearing that would let a
   * second read start alongside it.
   */
  private settleNewest(generation: number): void {
    if (this.newestInFlight !== generation) {
      return
    }
    this.newestInFlight = null
    if (this.newestPending && this.refreshWanted()) {
      // Passive: the only requests that join rather than hand the slot over are
      // refresh signals. Re-check applicability at settlement time because the
      // answer that just landed may itself have stopped refresh.
      this.startNewest(false)
    } else {
      this.newestPending = false
    }
  }

  private failNewest(key: string, generation: number): void {
    if (!this.wanted(key, generation, this.newestGeneration)) {
      return
    }
    this.thread = {
      ...this.thread,
      loading: false,
      error: 'Unable to load the conversation',
    }
    this.emit()
  }

  private wanted(key: string, generation: number, current: number): boolean {
    return !this.disposed && this.contextKey === key && current === generation
  }

  /**
   * Keep the refresh running exactly while it is wanted.
   *
   * Called after every newest page, because the answer can change the policy's
   * applicability: `inactive` is the one answer that stops it — a conversation
   * that has stopped growing does not need to be asked about again — while
   * `unknown` keeps it, because a live conversation frozen on screen is worse
   * than a re-read that changes nothing.
   */
  private refreshWanted(): boolean {
    return this.thread.state === 'ready' && this.thread.activity !== 'inactive'
  }

  private syncRefresh(): void {
    if (this.refreshWanted()) {
      this.startRefresh()
    } else {
      this.stopRefresh()
    }
  }

  /** Ask again while the open conversation is not known to be finished. */
  private startRefresh(): void {
    const key = this.contextKey
    const conversationId = this.loadedId
    const context = this.context
    const policy = this.adapter.refresh

    if (policy.kind === 'manual' || key === null || conversationId === null || context === null) {
      this.stopRefresh()
      return
    }

    const sourceKey =
      policy.kind === 'push' ? policy.sourceKey(context, conversationId) : null
    if (
      this.refreshArmedFor?.key === key &&
      this.refreshArmedFor.conversationId === conversationId &&
      this.refreshArmedFor.sourceKey === sourceKey
    ) {
      return
    }
    this.stopRefresh()

    if (policy.kind === 'poll') {
      this.timer = this.scheduler.setInterval(() => this.poll(), policy.intervalMs)
    } else {
      this.unsubscribePush = policy.subscribe(context, conversationId, () => {
        // Unsubscribe is not instantaneous for every source. A late event from
        // an old lease/socket is stale even when the conversation-space key and
        // conversation id are unchanged, so source identity participates in the
        // callback guard too.
        if (
          this.contextKey !== key ||
          this.loadedId !== conversationId ||
          this.refreshArmedFor?.sourceKey !== sourceKey
        ) {
          return
        }
        this.poll()
      })
    }
    this.refreshArmedFor = { key, conversationId, sourceKey }
  }

  private stopRefresh(): void {
    if (this.timer !== null) {
      this.scheduler.clearInterval(this.timer)
      this.timer = null
    }
    if (this.unsubscribePush !== null) {
      this.unsubscribePush()
      this.unsubscribePush = null
    }
    this.refreshArmedFor = null
  }

  /**
   * Re-read the newest page, swallowing a failure.
   *
   * The next tick asks again, and replacing a readable conversation with an
   * error because one tick missed would be a worse answer than a stale one. A
   * failure the reader should act on arrives through a load they asked for.
   */
  private poll(): void {
    this.requestNewest(false)
  }

  private emit(): void {
    const openId = this.openId()
    this.snapshot = {
      listState: this.list.state,
      conversations: this.list.conversations,
      bindingId: this.list.bindingId,
      openId,
      conversationKey: this.conversationKey(openId),
      state: this.thread.state,
      conversation: this.thread.conversation,
      activity: this.thread.activity,
      items: itemsOf(this.positions),
      hasMore: hasOlder(this.positions),
      partialTail: this.thread.state === 'ready' ? this.thread.partialTail : false,
      skipped: this.thread.state === 'ready' ? skippedOf(this.positions) : 0,
      listLoading: this.list.loading,
      threadLoading: openId !== null && this.thread.loading,
      loadingOlder: this.thread.loadingOlder,
      olderError: this.thread.olderError,
      listError: this.list.error,
      threadError: this.thread.error,
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
