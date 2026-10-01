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
export type AIRefreshPolicy =
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
       * Ask the provider to call `onChange` when the open conversation may have
       * changed. Returns the unsubscribe function; the runtime calls it on
       * disposal and whenever the open conversation changes.
       */
      subscribe: (onChange: () => void) => () => void
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

  list(context: Context): Promise<AIConversationListResult>

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

  readonly refresh: AIRefreshPolicy
}
