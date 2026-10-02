/**
 * Claude's records, translated into the shared conversation model.
 *
 * This is the only place in Nession that is allowed to know both vocabularies
 * at once, and the only place a Claude fact may be dropped or softened. What it
 * does *not* do is decide anything about presentation: it produces items, not
 * rows, and a reader looking for a tool's layout or a message's typography is
 * looking in the wrong file (#1363: "provider-specific tool summary 只在
 * adapter 中产生，不改变 renderer anatomy").
 *
 * ## What is a translation, and what is not
 *
 * Most of the wire is **already** the canonical shape, because #1222 converged
 * it there: `MessageContentV1` is `{type:'text'} | {type:'unknown'}`, the roles
 * are `user | assistant`, the tool statuses are
 * `running | success | error | unknown`, and the activity is
 * `active | inactive | unknown`. Those are passed through rather than copied
 * into a second, parallel union — a hand-kept copy of a union is the mistake
 * `capabilities/claude-code/types.ts` records about `ReadResponse`, and the
 * direction to be wrong in is a compile error when the two drift apart, which
 * is exactly what passing them through gives.
 *
 * Three translations are real, and each is named below.
 */

import type {
  AIConversationActivity,
  AIConversationItem,
  AIConversationSummary,
  AIToolCategory,
} from '@/shared/ai-conversation'
import type {
  ConversationActivityV1,
  ConversationItemV1,
} from '@/generated/protocol/claude-code/conversations/v1'
import type { MessageItemV1 } from '@/generated/protocol/claude-code/messages/v1'

/**
 * Claude's tool names, in the terms the shared summary counts in.
 *
 * This mapping is exactly the kind of thing `#1363` means by "provider-specific
 * tool summary 只在 adapter 中产生": the names are Claude's, the *categories*
 * are Nession's, and the renderer that draws "3 file reads · 1 command" never
 * learns what a `Grep` is.
 *
 * An unrecognised name is `other` rather than an error — a Claude release that
 * adds a tool must not break a transcript, and "1 other action" is an honest
 * description of a call this version cannot classify, which is what the shared
 * model's `other` arm is for.
 */
const CATEGORY_BY_TOOL: Record<string, AIToolCategory> = {
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
}

export function toCategory(name: string): AIToolCategory {
  return CATEGORY_BY_TOOL[name] ?? 'other'
}

/**
 * Claude's conversation, as the shared model's summary.
 *
 * **Translation 1: `cwd` is dropped.** The wire carries the working directory
 * the transcript recorded, and it is genuinely useful — for a directory-scoped
 * provider it would be part of how conversations are told apart. But it is not
 * part of what a *conversation* is in the shared model, and a summary field
 * that only one provider fills is how a shared model acquires a
 * provider-shaped hole. If a surface needs it later, it comes back as a
 * canonical field every provider can fill or as nothing.
 *
 * `title`, `preview` and `updated_at` survive as display metadata — never as
 * identity, which stays `id` alone.
 */
export function toSummary(
  item: ConversationItemV1,
  activity: AIConversationActivity,
): AIConversationSummary {
  return {
    id: item.id,
    title: item.title ?? null,
    preview: item.preview ?? null,
    activity,
    updatedAt: item.updated_at ?? null,
  }
}

/**
 * Claude's activity name for the shared one.
 *
 * Written out rather than passed through, even though the three names are
 * identical today: this is the one place where a Claude release that adds a
 * fourth state becomes a compile error here — which is the correct place for it
 * to be noticed — instead of silently reaching a renderer that has no arm for
 * it. `unknown` is the honest answer for a value this version does not
 * recognise, and it is a real state in the model, not a placeholder.
 */
export function toActivity(value: ConversationActivityV1): AIConversationActivity {
  return value === 'active' || value === 'inactive' ? value : 'unknown'
}

/**
 * One record of a transcript, as a shared item.
 *
 * **Translation 2: the tool's nesting is flattened.** The wire carries
 * `{kind:'tool', tool: {...}}`; the shared item carries the call's fields
 * directly. The renderer reads one shape instead of two, and a provider that
 * models work differently can still fill those fields.
 *
 * **Translation 3: a message's `status` is left absent.** Claude Code does not
 * say whether a message is still being written — the wire has no such field,
 * and the fact that a transcript was being appended to at read time is the
 * response's `partial_tail`, which is a property of the *page*, not of a
 * message. Inventing a per-message status here would make the adapter assert
 * something the provider never said; the shared renderer decides what a partial
 * tail means for presentation, once, for every provider.
 */
export function toItem(item: MessageItemV1): AIConversationItem {
  switch (item.kind) {
    case 'message':
      return {
        kind: 'message',
        id: item.id,
        role: item.role,
        timestamp: item.timestamp ?? null,
        content: item.content,
      }
    case 'tool':
      return {
        kind: 'tool',
        id: item.id,
        timestamp: item.timestamp ?? null,
        callId: item.tool.call_id,
        name: item.tool.name,
        category: toCategory(item.tool.name),
        status: item.tool.status,
        summary: item.tool.summary,
        input: item.tool.input ?? null,
        output: item.tool.output ?? null,
      }
    case 'unknown':
      return { kind: 'unknown', id: item.id, timestamp: item.timestamp ?? null }
  }
}
