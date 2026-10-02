import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolActivity, UnknownActivity } from '../../components/ToolActivity'
import type { AIToolStatus } from '../../model/conversation'
import { toolItem } from '../fixtures/items'

describe('ToolActivity', () => {
  it('is one collapsed line carrying what the call did and how it ended', () => {
    render(<ToolActivity item={toolItem('t1', { name: 'Bash', summary: 'cargo test' })} />)

    const row = screen.getByTestId('conversation-tool')
    expect(row.dataset.status).toBe('success')
    expect(screen.getByTestId('conversation-tool-name').textContent).toBe('Bash')
    expect(screen.getByText('cargo test')).toBeDefined()
    // `#1005` criterion 10: the call must not drown the conversation, so it
    // arrives closed and the body costs nothing until asked for.
    expect((row as HTMLDetailsElement).open).toBe(false)
  })

  it('says the outcome in words, so colour is not the only carrier', () => {
    const labels: Array<[AIToolStatus, string]> = [
      ['success', 'succeeded'],
      ['error', 'failed'],
      ['running', 'still running'],
      ['unknown', 'outcome not loaded'],
    ]
    for (const [status, label] of labels) {
      const { unmount } = render(<ToolActivity item={toolItem(`t-${status}`, { status })} />)
      expect(screen.getByText(label)).toBeDefined()
      unmount()
    }
  })

  it('never draws an unknown outcome as success', () => {
    render(<ToolActivity item={toolItem('t1', { status: 'unknown' })} />)

    // The provider recorded a call and no result. That says nothing about
    // whether it succeeded, and claiming otherwise would be fabricating a fact.
    expect(screen.getByTestId('conversation-tool-status').textContent).toBe('outcome not loaded')
    expect(screen.getByTestId('conversation-tool-status').className).not.toContain(
      'conversation-tool-success',
    )
  })

  it('keeps the summary line the adapter composed, unedited', () => {
    // `#1363`: refining a provider's tool detail is the adapter's job; laying
    // the row out is the renderer's. A renderer that rewrote this string would
    // be composing provider-specific copy in the shared layer.
    render(<ToolActivity item={toolItem('t1', { summary: 'Read 3 files' })} />)

    expect(screen.getByText('Read 3 files')).toBeDefined()
  })

  it('shows input and output only once the row is open', () => {
    render(
      <ToolActivity
        item={toolItem('t1', {
          input: { text: '{"command":"ls"}', kind: 'json', truncated: false },
          output: { text: 'a.txt', kind: 'text', truncated: false },
        })}
      />,
    )

    expect(screen.getByText('Input')).toBeDefined()
    expect(screen.getByText('Output')).toBeDefined()
    expect(screen.getByText('{"command":"ls"}')).toBeDefined()
  })

  it('says when a body was cut short', () => {
    render(
      <ToolActivity
        item={toolItem('t1', {
          output: { text: 'first 8000 chars', kind: 'text', truncated: true },
        })}
      />,
    )

    // A cut body is indistinguishable from a short one, and the reader judging
    // whether they have the whole answer is who needs to know they do not.
    expect(screen.getByTestId('conversation-tool-truncated')).toBeDefined()
  })

  it('says what is missing when the provider recorded no body', () => {
    const { rerender } = render(<ToolActivity item={toolItem('t1')} />)
    expect(screen.getByText('No arguments or output were recorded.')).toBeDefined()

    rerender(<ToolActivity item={toolItem('t1', { status: 'running' })} />)
    expect(screen.getByText('Still running.')).toBeDefined()
  })

  it('bounds a long body rather than letting it push the conversation', () => {
    render(
      <ToolActivity
        item={toolItem('t1', { output: { text: 'x'.repeat(5000), kind: 'text', truncated: false } })}
      />,
    )

    const body = screen.getByText('x'.repeat(5000))
    expect(body.style.maxHeight).toContain('--conversation-group-max-height')
  })
})

describe('UnknownActivity', () => {
  it('states an unmodelled record instead of dropping it', () => {
    render(<UnknownActivity />)

    // A transcript that silently omits records reads as a conversation that was
    // shorter than it was.
    expect(screen.getByTestId('conversation-unknown').textContent).toContain(
      'An event this version does not show',
    )
  })
})
