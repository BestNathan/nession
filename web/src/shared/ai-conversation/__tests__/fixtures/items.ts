/**
 * Small builders for canonical items, so a test reads as the conversation it
 * describes rather than as object literals.
 */

import type {
  AIConversationItem,
  AIMessageItem,
  AIToolItem,
} from '../../model/conversation'

export function userMessage(id: string, text: string): AIMessageItem {
  return { kind: 'message', id, role: 'user', content: [{ type: 'text', text }] }
}

export function assistantMessage(
  id: string,
  text: string,
  status?: AIMessageItem['status'],
): AIMessageItem {
  return {
    kind: 'message',
    id,
    role: 'assistant',
    ...(status ? { status } : {}),
    content: [{ type: 'text', text }],
  }
}

export function toolItem(
  id: string,
  overrides: Partial<Omit<AIToolItem, 'kind' | 'id'>> = {},
): AIToolItem {
  return {
    kind: 'tool',
    id,
    callId: `call-${id}`,
    name: 'Bash',
    status: 'success',
    summary: 'Ran a command',
    ...overrides,
  }
}

export function reasoningItem(
  id: string,
  summary = 'weighing the options',
  status: AIToolItem['status'] = 'success',
): AIConversationItem {
  return { kind: 'reasoning', id, summary, status }
}

export function unknownItem(id: string): AIConversationItem {
  return { kind: 'unknown', id }
}

/** A notice from the provider — not the assistant's work, so it never folds. */
export function statusItem(id: string, text = 'This turn was interrupted'): AIConversationItem {
  return { kind: 'status', id, text }
}

/** A conversation of `count` alternating messages, oldest first. */
export function transcript(count: number, prefix = 'm'): AIConversationItem[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? userMessage(`${prefix}${index}`, `question ${index}`)
      : assistantMessage(`${prefix}${index}`, `answer ${index}`),
  )
}
