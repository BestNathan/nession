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
  /** Records the adapter could not model, so the surface can say so. */
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
  skipped: number
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
  skipped: 0,
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

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export class ConversationRuntime<Context> {
  private readonly adapter: AIConversationAdapter<Context>
  private readonly scheduler: ConversationScheduler
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
  private refreshArmedFor: { key: string; conversationId: string } | null = null
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
   * A different context is a different conversation space: nothing about the
   * old one survives, not the items, not either cursor, not the binding.
   */
  setContext(context: Context | null): void {
    // Re-arms a disposed runtime. `dispose` means "stop everything now", not
    // "this instance is finished with": React's StrictMode mounts, unmounts and
    // mounts again, so a hook that disposes in its cleanup would hand a dead
    // runtime to the second mount. Pointing a runtime at a context is exactly
    // the statement that it should be working again.
    this.disposed = false
    this.context = context
    this.contextKey = context === null ? null : this.adapter.contextKey(context)
    this.newestGeneration += 1
    this.olderGeneration += 1
    this.positions = emptyPositions()
    this.list = EMPTY_LIST
    this.thread = EMPTY_THREAD
    this.loadedId = null
    this.stopRefresh()
    this.emit()
    if (context === null) {
      return
    }
    const key = this.contextKey as string
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
    const id = ++this.olderGeneration
    void this.fetchOlder(key, cursor, id)
    return true
  }

  /** Stop every timer and subscription, and refuse further work. */
  dispose(): void {
    this.disposed = true
    this.newestGeneration += 1
    this.olderGeneration += 1
    this.stopRefresh()
    this.listeners.clear()
  }

  // ── internals ────────────────────────────────────────────────────────────

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
    this.positions = emptyPositions()
    this.thread = EMPTY_THREAD
    this.stopRefresh()
    if (openId === null || this.context === null) {
      return
    }
    // A failure a reader should act on arrives through a load they asked for;
    // the first read is one they asked for by opening the surface, so it
    // reports. The poll is the path that swallows (see `poll`).
    const key = this.contextKey as string
    const generation = this.newestGeneration
    void this.fetchNewest(openId, key, generation).catch(() =>
      this.failNewest(key, generation),
    )
  }

  private async fetchList(key: string, generation: number): Promise<void> {
    const context = this.context
    if (context === null) {
      return
    }
    try {
      const result = await this.adapter.list(context)
      if (!this.wanted(key, generation, this.listGeneration)) {
        return
      }
      this.list = {
        state: result.state,
        conversations: result.conversations,
        bindingId: result.bindingId,
        loading: false,
        error:
          result.state === 'error'
            ? (result.error ?? 'The conversations could not be listed')
            : null,
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
      skipped: page.skipped,
      loading: false,
      error: null,
    }
    this.syncRefresh()
    this.emit()
  }

  /** Re-read the newest page of whatever is open. */
  private reloadNewest(): void {
    const key = this.contextKey
    const openId = this.loadedId
    if (key === null || openId === null || this.context === null) {
      return
    }
    const id = ++this.newestGeneration
    void this.fetchNewest(openId, key, id).catch(() => this.failNewest(key, id))
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
  private syncRefresh(): void {
    const wanted = this.thread.state === 'ready' && this.thread.activity !== 'inactive'
    if (wanted) {
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
    // Already watching exactly this. Re-arming would close and reopen a stream
    // on every poll of a conversation that has not moved.
    if (
      this.refreshArmedFor?.key === key &&
      this.refreshArmedFor.conversationId === conversationId
    ) {
      return
    }
    this.stopRefresh()

    if (policy.kind === 'poll') {
      this.timer = this.scheduler.setInterval(() => this.poll(), policy.intervalMs)
    } else {
      this.unsubscribePush = policy.subscribe(context, conversationId, () => {
        // The provider may emit once more before its unsubscribe lands. That
        // event is about a conversation the reader has left, so it is not a
        // reason to re-read the one they are in.
        if (this.contextKey !== key || this.loadedId !== conversationId) {
          return
        }
        this.poll()
      })
    }
    this.refreshArmedFor = { key, conversationId }
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
    const key = this.contextKey
    const openId = this.loadedId
    if (key === null || openId === null || this.context === null) {
      return
    }
    const id = ++this.newestGeneration
    void this.fetchNewest(openId, key, id).catch(() => undefined)
  }

  private emit(): void {
    const openId = this.openId()
    this.snapshot = {
      listState: this.list.state,
      conversations: this.list.conversations,
      bindingId: this.list.bindingId,
      openId,
      state: this.thread.state,
      conversation: this.thread.conversation,
      activity: this.thread.activity,
      items: itemsOf(this.positions),
      hasMore: hasOlder(this.positions),
      partialTail: this.thread.partialTail,
      skipped: this.thread.skipped,
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
