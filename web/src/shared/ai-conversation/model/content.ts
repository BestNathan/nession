/**
 * What a message is made of, in provider-neutral terms.
 *
 * The union is deliberately small. A provider whose transcript carries a block
 * this model does not name does **not** drop it: the block becomes
 * [`AIConversationContent`]'s `unknown` arm, which the renderer draws as a
 * bounded, visible fallback. Silence about content a user can see elsewhere is
 * the one outcome that is not allowed (#1363 SC-10).
 *
 * `image` / `file` / `citation` arms are absent on purpose rather than
 * forgotten. Nothing on the Claude Code wire emits them today, and the
 * requirement is explicit that a common semantic is added when a provider
 * demonstrates the need — "不要为尚未存在的 provider feature 预先设计大量 union".
 * Adding an arm is a one-line change to this union plus one arm in each
 * renderer, which is the cheap direction to be wrong in.
 */

/** A block of text the assistant or the user actually wrote. */
export interface AITextContent {
  type: 'text'
  text: string
}

/**
 * A block the adapter could not map onto the shared model.
 *
 * `sourceType` is the provider's own name for it, kept for diagnostics only —
 * the renderer must not switch on it, because doing so would be exactly the
 * provider branch this model exists to prevent.
 */
export interface AIUnknownContent {
  type: 'unknown'
  sourceType?: string
}

export type AIConversationContent = AITextContent | AIUnknownContent

/**
 * Who wrote a message.
 *
 * Two arms, not "everything else": a provider that distinguishes a third
 * participant (a system prompt, a tool result rendered as a message) must
 * decide which of these it is closest to at the adapter, where the decision is
 * visible, rather than teaching the renderer a new role.
 */
export type AIMessageRole = 'user' | 'assistant'

/**
 * Whether a message is still being written.
 *
 * `streaming` is a claim the provider made, not a guess from recency: a
 * transcript file being appended to does not make its last message live. When
 * the provider cannot say, the arm is absent and the renderer draws a settled
 * message — no animation, because there is nothing to animate.
 */
export type AIMessageStatus = 'streaming' | 'settled' | 'interrupted'

export interface AIMessageItem {
  kind: 'message'
  /**
   * Stable within the conversation. This is a contract, not a React key: it is
   * what keeps object identity across a poll, and therefore what keeps the
   * Markdown in a long transcript from being re-parsed every refresh (#1363
   * SC-07).
   */
  id: string
  role: AIMessageRole
  timestamp?: string | null
  status?: AIMessageStatus
  /** Never empty — a message whose blocks were all unmodelled is an unknown item. */
  content: AIConversationContent[]
}
