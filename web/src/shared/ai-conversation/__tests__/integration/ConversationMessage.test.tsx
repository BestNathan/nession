import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  AssistantMessage,
  ConversationMessage,
  UserMessage,
} from '../../components/ConversationMessage'
import { isStreaming } from '../../components/streaming'
import type { AIMessageItem } from '../../model/conversation'

function user(text: string, extra: Partial<AIMessageItem> = {}): AIMessageItem {
  return {
    kind: 'message',
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text }],
    ...extra,
  }
}

function assistant(text: string, extra: Partial<AIMessageItem> = {}): AIMessageItem {
  return {
    kind: 'message',
    id: 'a1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...extra,
  }
}

describe('ConversationMessage', () => {
  it('names the assistant after its provider and the user plainly', () => {
    const { rerender } = render(<ConversationMessage item={user('hi')} label="Claude" />)
    expect(screen.getByText('You')).toBeDefined()

    rerender(<ConversationMessage item={assistant('hello')} label="Claude" />)
    expect(screen.getByText('Claude')).toBeDefined()
    expect(screen.queryByText('You')).toBeNull()
  })

  it('draws the user inside a bounded surface and the assistant without one', () => {
    const { rerender } = render(<UserMessage item={user('hi')} />)
    const userBody = screen.getByTestId('conversation-user-body')
    // The bubble's cap is a token, not a literal, so App can state its own.
    expect(userBody.style.maxWidth).toContain('--conversation-bubble-max-width')

    rerender(<AssistantMessage item={assistant('hello')} label="Claude" />)
    const assistantBody = screen.getByTestId('conversation-assistant-body')
    // `#1167`: the assistant's Markdown *is* the content, so a second surface
    // around it would be chrome that says nothing.
    expect(assistantBody.className).not.toContain('conversation-user-surface')
    expect(assistantBody.style.maxWidth).toContain('--conversation-reading-column-max')
  })

  it('stretches the assistant and not the user, which is a correctness difference', () => {
    const { rerender } = render(<UserMessage item={user('short')} />)
    // `#1120` measured this: in a column flex container `items-start` sizes a
    // child to its fit-content width, and a code fence's min-content width is
    // its longest unwrapped line — so one long line pushes the reading column
    // out of the pane. The user's bubble is content-sized on purpose.
    expect(screen.getByTestId('conversation-turn').className).toContain('items-end')

    rerender(<AssistantMessage item={assistant('long')} label="Claude" />)
    expect(screen.getByTestId('conversation-turn').className).toContain('items-stretch')
  })

  it('renders both speakers through the shared Markdown path', () => {
    // A fenced block is the case that fails if either speaker falls back to
    // plain text, and a path is ordinary in a *prompt* as well as an answer.
    const { rerender } = render(<UserMessage item={user('see `src/app.tsx`')} />)
    expect(screen.getByText('src/app.tsx').tagName).toBe('CODE')

    rerender(<AssistantMessage item={assistant('```ts\nconst x = 1\n```')} label="Claude" />)
    // A fence must become a real code block — asserted on the body's text
    // rather than a single node, because the highlighter splits one line into
    // several spans and a node-level matcher would be testing the highlighter.
    const body = screen.getByTestId('conversation-assistant-body')
    expect(body.querySelector('pre, code')).not.toBeNull()
    expect(body.textContent).toContain('const x = 1')
    expect(body.textContent).not.toContain('```')
  })

  it('states an unmodelled block instead of dropping it', () => {
    const item = assistant('before')
    item.content = [{ type: 'text', text: 'before' }, { type: 'unknown' }, { type: 'text', text: 'after' }]

    render(<AssistantMessage item={item} label="Claude" />)

    // The block's *position* is the information: a message that quietly omitted
    // it would read as though it had said less than it did.
    expect(screen.getByText(/An unreadable block was here/)).toBeDefined()
    expect(screen.getByText(/after/)).toBeDefined()
  })

  it('shows a timestamp only when the record carried a usable one', () => {
    const { rerender } = render(
      <AssistantMessage item={assistant('hello', { timestamp: '2026-10-01T10:06:00Z' })} label="Claude" />,
    )
    expect(document.querySelector('time')?.dateTime).toBe('2026-10-01T10:06:00Z')

    rerender(<AssistantMessage item={assistant('hello', { timestamp: 'not a date' })} label="Claude" />)
    // An RFC 3339 string in the middle of a sentence is worse than no time.
    expect(document.querySelector('time')).toBeNull()
  })

  it('marks only the streaming assistant body', () => {
    const { rerender } = render(
      <AssistantMessage item={assistant('partial')} label="Claude" streaming />,
    )
    expect(screen.getByTestId('conversation-assistant-body').dataset.streaming).toBe('true')

    rerender(<AssistantMessage item={assistant('done')} label="Claude" />)
    expect(screen.getByTestId('conversation-assistant-body').dataset.streaming).toBeUndefined()
  })
})

describe('isStreaming', () => {
  const last = assistant('still going')

  it('applies the page’s partial tail to the trailing assistant message', () => {
    expect(isStreaming(last, true, true)).toBe(true)
  })

  it('never applies it to a message that is not last', () => {
    // Anything before the last row was followed by something the provider
    // considered complete.
    expect(isStreaming(last, false, true)).toBe(false)
  })

  it('never applies it to the user', () => {
    // A user's own message is never "still arriving", however partial the page.
    expect(isStreaming(user('hi'), true, true)).toBe(false)
  })

  it('is false when the page ended cleanly', () => {
    expect(isStreaming(last, true, false)).toBe(false)
  })
})
