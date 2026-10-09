/**
 * The one contract a provider implements to get a conversation experience.
 *
 * ## What this file is for
 *
 * A provider owns a protocol: a wire format, a filesystem layout, a CLI's
 * output. Nession owns the conversation. This is the seam between them, and it
 * is deliberately narrow — a provider that can fill these three methods gets
 * the list, the transcript, the paging, the streaming states, the tool
 * disclosure, the scroll behaviour and the accessibility contract without
 * writing any of them.
 *
 * ## What a provider may not put here
 *
 * There is no React node in this file, and that is the point (#1363 SC-10). A
 * provider cannot supply a user bubble, an assistant paragraph, a tool card, a
 * loading line or an error row. The requirement's rule is blunt about it:
 * "不允许 provider adapter 通过 ReactNode/JSX 覆盖 UserMessage、
 * AssistantMessage、ToolActivity 等核心 renderer".
 *
 * A provider that has a rich block the shared model cannot express maps it to
 * `unknown` first. If the block turns out to matter to more than one provider,
 * the shared model grows an arm for it — in `model/`, where every provider gets
 * it — rather than the provider getting a hole to draw in.
 *
 * ## React-free, and why that is enforced by the layer rather than by taste
 *
 * This module lives in `shared/`, which `nession/no-reverse-imports` forbids
 * from importing any business layer. The runtime that consumes it is a plain
 * class with a `subscribe`/`getSnapshot` pair, so it can be unit-tested in the
 * node project without a DOM, a renderer or a testing library — which is where
 * the paging, generation and reconciliation behaviour is actually proved.
 */

import type {
  AIConversationActivity,
  AIConversationItem,
  AIConversationListState,
  AIConversationReadState,
  AIConversationSummary,
} from '../model/conversation'

/**
 * What the provider is being asked about — a Session, an agent, a working
 * directory, whatever makes a request well-formed for that provider.
 *
 * Opaque to the runtime: it is passed back to the adapter unchanged, and the
 * only thing the runtime needs to know about it is the key the adapter derives
 * for it (see [`AIConversationAdapter.contextKey`]).
 */
export type AIConversationContext = unknown

/**
 * The provider's name for itself, as far as the shared UI is concerned.
 *
 * Two fields, because these are the only two facts the shared experience is
 * allowed to vary by (#1363: "Provider identity只允许影响少量语义信息"). A
 * provider does not get to vary hierarchy, spacing, anatomy or interaction
 * rules by declaring something here — there is nowhere to declare it.
 */
export interface AIConversationIdentity {
  /** How the assistant is named in the transcript, e.g. `Claude`. */
  label: string
}

/** A directory of conversations, plus the one the context currently implies. */
export interface AIConversationListResult {
  state: AIConversationListState
  conversations: AIConversationSummary[]
  /**
   * The exact conversation this context is bound to, when the provider knows
   * one.
   *
   * An **exact id**, never a heuristic. #1222 settled this: the auto-open that
   * a user experiences as "it opened where I was" must follow an id the
   * provider named, not the newest timestamp and not a list of one. A provider
   * that cannot determine a binding returns `null`, and the runtime shows the
   * list rather than guessing.
   */
  bindingId: string | null
  /**
   * Pass back to `list` to continue the directory. `null` means complete.
   *
   * List pagination is part of the canonical contract rather than a provider
   * ceiling: a provider whose API caps one response must not silently make the
   * rest of the directory unreachable (#1363 round 6).
   */
  nextCursor: string | null
  /**
   * Stable identity of the directory snapshot this page belongs to.
   *
   * A paged provider must return the same non-null id for every page reached
   * from one first-page read. The runtime uses it to reject a continuation that
   * quietly crossed into a re-sorted/rebound directory (#1363 round 7).
   * Single-page providers may leave it null/undefined because there is no
   * continuation boundary to make inconsistent.
   */
  listingId?: string | null
  /**
   * The supplied cursor belonged to a directory snapshot that no longer exists.
   *
   * This is not a list failure: it asks the shared runtime to discard only the
   * in-progress aggregation and restart from page one, under the same logical
   * context. Providers use this instead of silently applying an offset cursor
   * to a freshly re-sorted directory.
   */
  restart?: boolean
  error?: string | null
}

/** One page of a conversation's timeline, oldest-first within the page. */
export interface AIConversationPage {
  state: AIConversationReadState
  /**
   * The conversation itself, from this response.
   *
   * Carried so the header never joins back against the list by id — the
   * response that describes the timeline also describes what the timeline
   * belongs to.
   */
  conversation?: AIConversationSummary | null
  activity?: AIConversationActivity | null
  items: AIConversationItem[]
  /** Pass back to read the page before this one. Absent when there is none. */
  nextCursor?: string | null
  /**
   * The transcript ended mid-record while being read.
   *
   * **Not an error.** A transcript being appended to routinely ends in a
   * partial line, and everything complete before it must still render.
   */
  partialTail: boolean
  /** How many records the adapter could not model, so the surface can say so. */
  skipped: number
  error?: string | null
}

/**
 * How the runtime learns that a conversation changed.
 *
 * The provider declares the mechanism; the runtime owns the resulting state.
 * That split is #1363 SC-06 — "Polling 与 push refresh 均可通过 adapter/source
 * contract 驱动同一个 runtime snapshot，UI 不含 transport-specific branch" — and
 * it is why `kind` is a discriminated union rather than a boolean: a provider
 * that later gains a stream adds an arm here, and the runtime handles it once,
 * instead of every surface learning a second refresh path.
 */
export type AIRefreshPolicy<Context = AIConversationContext> =
  | {
      kind: 'poll'
      /**
       * How often to re-read the newest page while the conversation is not
       * known to be finished.
       */
      intervalMs: number
    }
  | {
      kind: 'push'
      /**
       * Ask the provider to call `onChange` when **this** conversation may have
       * changed. Returns the unsubscribe function; the runtime calls it on
       * disposal and whenever the open conversation changes.
       *
       * The target is passed rather than left for the provider to remember. A
       * stream is per-conversation in every provider that has one, and a
       * provider asked to subscribe without being told to what can only
       * subscribe globally and re-read indiscriminately — a filter wearing an
       * adapter's name, which is the shape #1363 SC-06 exists to rule out.
       */
      /**
       * Stable identity of the concrete refresh source.
       *
       * `contextKey` identifies the conversation *space*; it deliberately may
       * stay equal while a token, client, lease, socket, or other source handle
       * changes. A push subscription captures that handle, so the runtime needs
       * one provider-owned key that changes exactly when the subscription must
       * be re-established. Object identity is explicitly not that key.
       */
      sourceKey: (context: Context, conversationId: string) => string
      subscribe: (
        context: Context,
        conversationId: string,
        onChange: () => void,
      ) => () => void
    }
  | {
      /** Neither — the user asks, and only the user asks. */
      kind: 'manual'
    }

/**
 * A provider's conversation integration.
 *
 * Three methods and two fields. Everything else a provider might want to say
 * about its conversations is either already in the items it returns, or is a
 * change to the shared model that every provider should get.
 */
export interface AIConversationAdapter<Context = AIConversationContext> {
  /** Stable identifier, e.g. `claude-code`. Used for diagnostics, not display. */
  readonly id: string
  readonly identity: AIConversationIdentity

  /**
   * A key that is equal exactly when two contexts mean the same conversation
   * space.
   *
   * This is an addition to the contract as the requirement sketches it, and it
   * is here because only the provider can answer it: for a Session-scoped
   * provider the key is the Session, for a directory-scoped one it is the path.
   * The runtime uses it for two things it cannot do without — tagging an
   * explicit selection with the context it was made in (so a context change
   * cannot carry the old choice), and discarding a response that arrived after
   * the context moved on (#1363's edge case "provider switches while old read
   * is in flight").
   */
  contextKey(context: Context): string

  /**
   * Identity of the request authority captured by list/read calls.
   *
   * Usually this is the same value as `contextKey`. A provider whose logical
   * conversation space stays equal while a token, lease, client or other
   * request-capable handle rotates must return a different key here. Changing
   * it invalidates old in-flight list/read work without resetting the reader's
   * selection or loaded window. Object identity is never used for this.
   *
   * Optional for providers whose request authority is exactly their
   * `contextKey`; the runtime falls back to that key.
   */
  requestKey?(context: Context): string

  /**
   * Read one page of the conversation directory.
   *
   * Without a cursor this is the first page; with one it continues from a
   * previous `nextCursor`. The shared runtime walks a coherent listing to
   * completion under a hard page/restart budget. Paged providers therefore
   * supply `listingId`, and stale continuation cursors return `restart: true`
   * rather than being applied to a freshly re-sorted directory.
   */
  list(context: Context, cursor?: string): Promise<AIConversationListResult>

  /**
   * Read one page of a conversation.
   *
   * `conversationId` is always explicit — it is the only selection mechanism
   * this contract has, and the runtime never asks a provider to find "the
   * current one". Without a `cursor`, this is the newest page; with one, the
   * page before the loaded window.
   */
  read(
    context: Context,
    conversationId: string,
    cursor?: string,
  ): Promise<AIConversationPage>

  readonly refresh: AIRefreshPolicy<Context>
}
