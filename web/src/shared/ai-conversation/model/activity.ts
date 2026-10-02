/**
 * Work a conversation did, as opposed to words it said.
 *
 * A tool call and its result are **one** item, not two. The provider pairs them
 * before the item reaches this model — a call whose result has not arrived is a
 * `running` item, not a call item waiting for a result item — because the
 * alternative is a renderer that has to know which providers pair their own
 * records and which do not (#1363 SC-08, and the edge case "tool result arrives
 * after tool call" in the requirement).
 *
 * The wire nests this under a `tool` key on a `{kind:'tool'}` item. It is
 * flattened here so the renderer reads one shape rather than two, and so a
 * future provider that models work differently can still fill these fields.
 */

/**
 * How the call ended.
 *
 * `unknown` is a real answer, not a placeholder: a transcript that recorded a
 * call and never a result says nothing about whether the call succeeded, and
 * drawing it as a success would be fabricating a fact. The requirement's edge
 * case names this directly — "tool call never receives result | remains
 * running/unknown according to adapter fact, never fabricated as success".
 */
export type AIToolStatus = 'running' | 'success' | 'error' | 'unknown'

/**
 * What kind of work the call did, in the terms a reader thinks in.
 *
 * A collapsed group is summarised by *category* rather than by tool name
 * (`#1363`: "group summary 优先用动作类别 + bounded live detail，不堆原始 tool
 * 名"), because the names are the provider's: one provider's `Bash` is another's
 * `shell`, and a summary built from names would read as a list of implementation
 * details rather than as a description of the work.
 *
 * The mapping is the adapter's, because only it knows what its tools do. This
 * is deliberately a small closed set rather than a free string: a provider that
 * needs a new category has found a *shared* concept, and adding it here is how
 * every provider gets it — which is the same rule the model's other unions
 * follow.
 *
 * Absent means "the adapter did not classify it", and the summary falls back to
 * the names it does have rather than guessing.
 */
export type AIToolCategory =
  | 'command'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'fetch'
  | 'other'

/**
 * A tool's input or output, as the provider could give it.
 *
 * `kind` tells the renderer whether to pretty-print (JSON) or show verbatim
 * (everything else). `truncated` is carried rather than inferred, because a
 * payload that was cut off must say so instead of looking complete.
 */
export interface AIToolPayload {
  text: string
  kind: 'json' | 'text'
  truncated: boolean
}

/**
 * The assistant thinking, as opposed to what it did or what it said.
 *
 * ## Why this arm exists before any provider emits one
 *
 * The model's own rule is the opposite of this. `content.ts` states it — an arm
 * is added when a provider demonstrates the need, not when one is imagined
 * ("不要为尚未存在的 provider feature 预先设计大量 union") — and that rule is
 * why `image` / `file` / `citation` are absent from the content union on
 * purpose.
 *
 * **This arm is a recorded exception to it, made deliberately by the repository
 * owner on 2026-10-02.** The reason is that the requirement does not merely
 * allow reasoning, it *names* it: `#1363`'s interaction model is
 * `Turn → Process Group → Tool/Reasoning`, and a disclosure hierarchy that has
 * nowhere to put reasoning is not the hierarchy that was asked for. The
 * alternative — wait for the first provider — means the *shape* of the feature
 * arrives fused to that provider's dialect, which is the coupling the whole
 * adapter boundary exists to prevent.
 *
 * What that costs, said now so it is not discovered later:
 *
 * - The renderer carries a row no adapter produces yet. Its tests are the only
 *   evidence it works, which makes them the thing to keep honest.
 * - **Nothing is required of a provider.** An adapter with no reasoning simply
 *   never emits one, exactly as it never emits a tool it does not have. Absent
 *   reasoning is the ordinary case, not a failure, and no surface may treat it
 *   as one.
 *
 * What would retire the exception: the first adapter that emits this is also the
 * first real evidence about its fields. Whoever writes it should expect to
 * reshape `summary` and `status` to what that provider actually says, and to
 * delete this note when the arm is no longer speculative.
 */
export interface AIReasoningItem {
  kind: 'reasoning'
  /** Stable within the conversation — see [`AIMessageItem.id`](./content.ts). */
  id: string
  timestamp?: string | null
  /**
   * One line of what it thought, as the provider gives it.
   *
   * The provider's own words or its own summary, never this client's paraphrase:
   * a transcript that rewrote someone's reasoning would be asserting a thought
   * nobody had.
   */
  summary: string
  /**
   * Whether the thinking has finished.
   *
   * [`AIToolStatus`] rather than a second vocabulary, because the process window
   * reads one: a group's summary counts what is still running, and reasoning
   * that could not answer "still running?" would have to be counted separately
   * for no reason a reader would recognise. Only `running` and `success` are
   * meaningful here — a thought does not fail, it stops.
   */
  status: AIToolStatus
}

/**
 * Something the provider said that is not the assistant's work.
 *
 * ## Why this arm exists before any provider emits one
 *
 * The same recorded exception as [`AIReasoningItem`] above, on the same
 * grounds — the requirement does not merely allow this, it *names* it. `#1363`
 * SC-03 lists `status` beside the message, tool and unknown kinds. Without the
 * arm a provider's notice has nowhere to go but `unknown`, and the semantics
 * then arrive fused to whichever provider needs them first, which is the
 * coupling the adapter boundary exists to prevent.
 *
 * ## It does not fold, and that was a decision
 *
 * Worth stating plainly, because the canonical document states the rule twice
 * and the two statements disagree. `docs/design/design-system/patterns/
 * conversation.md` draws `reasoning / status rows` *inside* the process window,
 * and nine lines later says a status notice "never fold[s] into the process".
 *
 * Resolved towards the second, and the diagram was converged in the same
 * change. A notice is *about* the conversation rather than produced by the
 * assistant working on it — "this turn was interrupted", "that host went away"
 * — and a reader folding the work away is asking to see the answer, not to lose
 * the reason there isn't one. SC-03's own grouping supports this: it lists
 * `status` with the conversation *states* (error, empty, loading), not with the
 * content kinds. So `turnsOf` leaves these out of the process window, which is
 * what the renderer reads to decide what folds.
 *
 * ## What is deliberately not here
 *
 * No severity. "Notice, warning, error" is a vocabulary nobody has needed yet,
 * and `content.ts`'s rule — add an arm when a provider demonstrates the need,
 * not when one is imagined — applies to a field as much as to a type. The
 * provider's own words carry the tone until something has to be styled by it.
 *
 * **Nothing is required of a provider.** An adapter with no notices never emits
 * one, exactly as it never emits a tool it does not have.
 */
export interface AIStatusItem {
  kind: 'status'
  /** Stable within the conversation — see [`AIMessageItem.id`](./content.ts). */
  id: string
  timestamp?: string | null
  /**
   * What the provider said, in its own words.
   *
   * Nession owns the row and does not own the sentence. If a provider's text
   * cannot be shown as given, the answer is a provider that says less — never
   * this client paraphrasing what it thinks happened.
   */
  text: string
}

export interface AIToolItem {
  kind: 'tool'
  /** Stable within the conversation — see [`AIMessageItem.id`](./content.ts). */
  id: string
  timestamp?: string | null
  /**
   * The provider's identity for the *call*, which is not the same as the row's.
   *
   * Two `Bash` calls in one turn are told apart by this and by nothing else.
   * It is what a live update correlates against, and it is why the wire carries
   * it rather than keeping it provider-side.
   */
  callId: string
  /**
   * The tool's own name, e.g. `Bash`. Shown, but not as the row's subject: the
   * collapsed summary leads with what the call *did*.
   */
  name: string
  /** The adapter's classification; absent when it did not make one. */
  category?: AIToolCategory
  status: AIToolStatus
  /**
   * One line describing the call, refined by the adapter from provider
   * specifics. The renderer lays this out; it never composes it.
   */
  summary: string
  input?: AIToolPayload | null
  output?: AIToolPayload | null
}
