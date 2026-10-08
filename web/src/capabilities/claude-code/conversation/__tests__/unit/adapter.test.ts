import { describe, expect, it, vi } from 'vitest'
import { ConversationRuntime } from '@/shared/ai-conversation'
import { createClaudeCodeAdapter } from '../../adapter'
import { toActivity, toCategory, toItem, toSummary } from '../../normalizers'
import type { ClaudeCodeConversationsResponse, ClaudeCodeMessagesResponse } from '../../../types'

const context = { agentId: 'agent-1', sessionId: 'session-1' }

function conversationsResponse(
  overrides: Partial<ClaudeCodeConversationsResponse> = {},
): ClaudeCodeConversationsResponse {
  return { state: 'ready', has_more: false, ...overrides }
}

function messagesResponse(
  overrides: Partial<ClaudeCodeMessagesResponse> = {},
): ClaudeCodeMessagesResponse {
  return { state: 'ready', has_more: false, partial_tail: false, skipped: 0, ...overrides }
}

function apiWith(
  conversations: ClaudeCodeConversationsResponse,
  messages: ClaudeCodeMessagesResponse = messagesResponse(),
) {
  return {
    claudeCodeConversations: vi.fn().mockResolvedValue(conversations),
    claudeCodeMessages: vi.fn().mockResolvedValue(messages),
  }
}

describe('Claude Code normalizers', () => {
  it('keeps display metadata and drops the working directory', () => {
    const summary = toSummary(
      {
        id: 'c1',
        cwd: '/home/dev/project',
        title: 'A conversation',
        preview: 'do the thing',
        updated_at: '2026-10-01T10:00:00Z',
      },
      'active',
    )

    expect(summary).toEqual({
      id: 'c1',
      title: 'A conversation',
      preview: 'do the thing',
      activity: 'active',
      updatedAt: '2026-10-01T10:00:00Z',
    })
    // `cwd` is not a canonical field, and a summary with a provider-only hole
    // is how the shared model stops being shared.
    expect(summary).not.toHaveProperty('cwd')
  })

  it('turns an unrecognised activity into unknown rather than passing it on', () => {
    expect(toActivity('active')).toBe('active')
    expect(toActivity('inactive')).toBe('inactive')
    expect(toActivity('unknown')).toBe('unknown')
  })

  it('flattens a tool call and keeps its pairing', () => {
    const item = toItem({
      kind: 'tool',
      id: 't1',
      timestamp: '2026-10-01T10:00:00Z',
      tool: {
        call_id: 'call-1',
        name: 'Bash',
        status: 'running',
        summary: 'cargo test',
        input: { text: '{"command":"cargo test"}', kind: 'json', truncated: false },
        output: null,
      },
    })

    expect(item).toEqual({
      kind: 'tool',
      id: 't1',
      timestamp: '2026-10-01T10:00:00Z',
      callId: 'call-1',
      name: 'Bash',
      // The mapping is Claude's; the category is Nession's vocabulary.
      category: 'command',
      status: 'running',
      summary: 'cargo test',
      input: { text: '{"command":"cargo test"}', kind: 'json', truncated: false },
      output: null,
    })
  })

  it('leaves a message status absent, because Claude never states one', () => {
    const item = toItem({
      kind: 'message',
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    })

    expect(item).toMatchObject({ kind: 'message', id: 'm1', role: 'assistant' })
    // Whether a message is still being written is the page's `partial_tail`,
    // not a per-message claim this provider can make.
    expect(item).not.toHaveProperty('status')
  })

  it('classifies a tool into the shared vocabulary, and an unknown tool into other', () => {
    expect(toCategory('Grep')).toBe('search')
    expect(toCategory('Edit')).toBe('edit')
    // A Claude release that adds a tool must not break a transcript: an
    // unclassifiable call is `other`, which is an honest description rather
    // than a failure or a guess.
    expect(toCategory('SomeFutureTool')).toBe('other')
  })

  it('keeps an unmodelled record as an unknown item', () => {
    expect(toItem({ kind: 'unknown', id: 'x1', timestamp: null })).toEqual({
      kind: 'unknown',
      id: 'x1',
      timestamp: null,
    })
  })
})

describe('Claude Code adapter', () => {
  it('names the Session as the conversation space', () => {
    const adapter = createClaudeCodeAdapter(apiWith(conversationsResponse()))
    expect(adapter.contextKey(context)).toBe('agent-1:session-1')
    expect(adapter.requestKey?.(context)).toBe('agent-1:session-1')
    expect(adapter.identity.label).toBe('Claude')
  })

  it('maps one directory page, its cursor, and the exact binding', async () => {
    const api = apiWith(
      conversationsResponse({
        items: [
          { id: 'c1', cwd: '/w', title: 'One', preview: null, updated_at: null },
          { id: 'c2', cwd: '/w', title: 'Two', preview: null, updated_at: null },
        ],
        binding: { conversation_id: 'c2', activity: 'active' },
        has_more: true,
        next_cursor: 'listing-a:200',
      }),
    )
    const adapter = createClaudeCodeAdapter(api)

    const result = await adapter.list(context)

    expect(api.claudeCodeConversations).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      session_id: 'session-1',
      limit: 200,
    })
    expect(result.bindingId).toBe('c2')
    expect(result.nextCursor).toBe('listing-a:200')
    expect(result.listingId).toBe('listing-a')
    // The binding's activity is a fact about the binding, relative to this
    // Session. The wire says nothing about the others, so they say `unknown`
    // rather than borrowing the binding's answer.
    expect(result.conversations.map((c) => c.activity)).toEqual(['unknown', 'active'])
  })

  it('rejects a list page that says more exists without a continuation cursor', async () => {
    const api = apiWith(conversationsResponse({ has_more: true, next_cursor: null }))
    const adapter = createClaudeCodeAdapter(api)

    await expect(adapter.list(context)).rejects.toThrow(
      'Claude conversation list said more pages exist without a cursor',
    )
  })

  it('passes the shared list cursor back to the provider', async () => {
    const api = apiWith(conversationsResponse())
    const adapter = createClaudeCodeAdapter(api)

    await adapter.list(context, 'listing-a:200')

    expect(api.claudeCodeConversations).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      session_id: 'session-1',
      limit: 200,
      cursor: 'listing-a:200',
    })
  })

  it('maps a stale provider listing to a canonical restart', async () => {
    const api = apiWith(
      conversationsResponse({
        state: 'error',
        error: 'listing_changed',
        has_more: false,
      }),
    )
    const adapter = createClaudeCodeAdapter(api)

    const result = await adapter.list(context, 'listing-a:200')

    expect(result.restart).toBe(true)
    expect(result.state).toBe('error')
  })

  it('reads a page and maps the cursor through', async () => {
    const api = apiWith(
      conversationsResponse(),
      messagesResponse({
        conversation: { id: 'c1', cwd: '/w', title: 'One', preview: null, updated_at: null },
        activity: 'inactive',
        items: [{ kind: 'message', id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        next_cursor: 'older-1',
        partial_tail: true,
        skipped: 2,
      }),
    )
    const adapter = createClaudeCodeAdapter(api)

    const page = await adapter.read(context, 'c1', 'cursor-0')

    expect(api.claudeCodeMessages).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      session_id: 'session-1',
      conversation_id: 'c1',
      limit: 60,
      cursor: 'cursor-0',
    })
    expect(page).toMatchObject({
      state: 'ready',
      activity: 'inactive',
      nextCursor: 'older-1',
      partialTail: true,
      skipped: 2,
    })
    expect(page.conversation).toMatchObject({ id: 'c1', activity: 'inactive' })
    expect(page.items).toHaveLength(1)
  })

  it('omits the cursor entirely for the newest page', async () => {
    const api = apiWith(conversationsResponse())
    const adapter = createClaudeCodeAdapter(api)

    await adapter.read(context, 'c1')

    // `cursor: undefined` and no cursor are different requests to this
    // provider — the wire treats presence as the discriminator.
    expect(api.claudeCodeMessages.mock.calls[0]?.[0]).not.toHaveProperty('cursor')
  })

  it('carries a not_found through without inventing a conversation', async () => {
    const api = apiWith(conversationsResponse(), messagesResponse({ state: 'not_found' }))
    const adapter = createClaudeCodeAdapter(api)

    const page = await adapter.read(context, 'gone')

    expect(page.state).toBe('not_found')
    expect(page.conversation).toBeNull()
    expect(page.items).toEqual([])
  })
})

describe('the runtime driven by the Claude Code adapter', () => {
  it('opens the bound conversation and pages backwards through it', async () => {
    const api = apiWith(
      conversationsResponse({
        items: [{ id: 'c1', cwd: '/w', title: 'One', preview: null, updated_at: null }],
        binding: { conversation_id: 'c1', activity: 'active' },
      }),
      messagesResponse({
        conversation: { id: 'c1', cwd: '/w', title: 'One', preview: null, updated_at: null },
        activity: 'active',
        items: [{ kind: 'message', id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        next_cursor: 'older',
      }),
    )
    const runtime = new ConversationRuntime(createClaudeCodeAdapter(api))

    runtime.setContext(context)
    await vi.waitFor(() => expect(runtime.getSnapshot().openId).toBe('c1'))

    expect(runtime.getSnapshot().items.map((item) => item.id)).toEqual(['m1'])
    expect(runtime.getSnapshot().hasMore).toBe(true)

    api.claudeCodeMessages.mockResolvedValueOnce(
      messagesResponse({
        items: [{ kind: 'unknown', id: 'm0', timestamp: null }],
        next_cursor: null,
      }),
    )
    expect(runtime.loadOlder()).toBe(true)
    await vi.waitFor(() => expect(runtime.getSnapshot().items).toHaveLength(2))

    expect(runtime.getSnapshot().items.map((item) => item.id)).toEqual(['m0', 'm1'])
    runtime.dispose()
  })
})
