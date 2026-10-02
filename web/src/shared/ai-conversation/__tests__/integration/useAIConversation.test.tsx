import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useAIConversation } from '../../runtime/useAIConversation'
import { SyntheticAdapter, flush } from '../fixtures/syntheticAdapter'
import { transcript } from '../fixtures/items'

/** A surface in miniature: a context in, the snapshot's items out. */
function Surface({ context }: { context: string | null }) {
  const adapter = moduleAdapter
  const { snapshot } = useAIConversation(adapter, context)
  return (
    <ul data-testid="items">
      {snapshot.items.map((item) => (
        <li key={item.id}>{item.id}</li>
      ))}
    </ul>
  )
}

const moduleAdapter = new SyntheticAdapter({
  conversations: [{ id: 'c1', title: 'One', activity: 'inactive', items: transcript(4) }],
  bindingId: 'c1',
  pageSize: 10,
})

/**
 * Two providers, and a surface told which to draw.
 *
 * The bindings deliberately differ, so the assertion is about *which provider
 * answered* rather than about whether anything rendered.
 */
function Switchable({
  adapter,
  context,
}: {
  adapter: SyntheticAdapter
  context: string
}) {
  const { snapshot } = useAIConversation(adapter, context)
  return <span data-testid="binding">{snapshot.bindingId ?? 'none'}</span>
}

describe('switching providers', () => {
  const providerA = () =>
    new SyntheticAdapter({
      conversations: [{ id: 'c1', title: 'One', activity: 'inactive', items: transcript(2) }],
      bindingId: 'c1',
      pageSize: 10,
    })
  const providerB = () =>
    new SyntheticAdapter({
      conversations: [{ id: 'c2', title: 'Two', activity: 'inactive', items: transcript(2) }],
      bindingId: 'c2',
      pageSize: 10,
    })

  it('answers from the provider it was given, not from the first one', async () => {
    // #1363 round 3: `useState`'s initialiser runs once, so the runtime used to
    // outlive the adapter it was built for and go on answering the first
    // provider. A second provider could be registered and never drawn.
    const { rerender } = render(<Switchable adapter={providerA()} context="a:s1" />)
    await waitFor(() => expect(screen.getByTestId('binding').textContent).toBe('c1'))

    rerender(<Switchable adapter={providerB()} context="a:s1" />)

    await waitFor(() => expect(screen.getByTestId('binding').textContent).toBe('c2'))
  })

  it('cannot let the previous provider’s late answer land', async () => {
    // The half that makes the swap safe rather than merely different. A's read
    // is held open across the switch, so it is genuinely in flight when the
    // runtime that asked for it is disposed.
    const first = providerA()
    const release = first.hold('list')

    const { rerender } = render(<Switchable adapter={first} context="a:s1" />)
    rerender(<Switchable adapter={providerB()} context="a:s1" />)
    await waitFor(() => expect(screen.getByTestId('binding').textContent).toBe('c2'))

    release()
    await flush()

    // Still B. A disposed runtime refuses everything through `wanted()`, and its
    // generation counters belong to it alone.
    expect(screen.getByTestId('binding').textContent).toBe('c2')
  })
})

describe('useAIConversation', () => {
  it('opens the provider’s binding for the context it was given', async () => {
    render(<Surface context="a:s1" />)

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4))
    expect(screen.getByText('m0')).toBeDefined()
  })

  it('renders nothing for no context rather than guessing one', async () => {
    render(<Surface context={null} />)

    await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0))
  })

  it('re-points at a new context when the key changes', async () => {
    const { rerender } = render(<Surface context="a:s1" />)
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4))

    // A different Session is a different conversation space: nothing about the
    // old one may remain.
    rerender(<Surface context="a:s2" />)
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4))
  })

  it('keeps its commands stable across renders', async () => {
    // Not a micro-optimisation. The transcript watches `loadOlder` in an effect
    // dependency list — a page arriving is what should pull the next one — so
    // an identity that changed every render would re-run that effect every
    // render and page for reasons unrelated to a page arriving. This is what
    // makes the paging trigger deliberate rather than accidental.
    const seen: Array<() => boolean> = []
    function Recorder() {
      const handle = useAIConversation(moduleAdapter, 'a:s1')
      seen.push(handle.loadOlder)
      return null
    }

    const { rerender } = render(<Recorder />)
    await waitFor(() => expect(seen.length).toBeGreaterThan(1))
    rerender(<Recorder />)

    expect(seen.length).toBeGreaterThan(2)
    expect(new Set(seen).size).toBe(1)
  })

  it('survives StrictMode’s mount, unmount and mount again', async () => {
    // Development renders effects twice, disposing in between. A hook that
    // disposed into a dead runtime would show an empty conversation here and
    // nowhere else — which is exactly the kind of bug that only appears in dev.
    render(
      <StrictMode>
        <Surface context="a:s1" />
      </StrictMode>,
    )

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4))
  })
})
