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
