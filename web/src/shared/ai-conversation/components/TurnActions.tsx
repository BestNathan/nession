/**
 * What a reader can do with a turn they have read.
 *
 * `conversation.md`'s anatomy ends a turn with "turn actions ← copy, and whatever
 * the surface adds", and the geometry rule is what makes it safe to add them:
 * "nothing that appears on hover, on focus, or as a result of streaming may move
 * the content below it. Rows that reserve space and change only their opacity
 * are the mechanism; `display` changes are not."
 *
 * ## The row keeps its height whether or not it is lit
 *
 * The row is drawn at `foldControlHeight` and the actions inside fade. A row
 * that appeared on hover would move the answer up and down under the reader's
 * pointer — and in a transcript "below it" is everywhere the reader is about to
 * look, so the movement would land on the thing they were reading.
 *
 * ## Reserved before it is available
 *
 * The row is drawn as soon as there is an answer to sit under; the action
 * inside it waits until the turn has settled. Both halves carry weight: the
 * reserved row is what keeps the rule above, and withholding the action is what
 * keeps the footer from announcing completion while the turn's own process is
 * still open (`#1363` round 4). A reader never sees the row appear — only the
 * button, inside space that was already there.
 *
 * ## Revealed where there is a pointer, unconditional where there is not
 *
 * The Web/App table asks for actions "revealed on hover/focus" on Web and
 * "always reachable" on App, and the anti-pattern list names "hover-only access
 * to an action". Both come to one rule stated as the *capability* rather than as
 * the experience: reveal where the device can hover, and show unconditionally
 * where it cannot. `pointer-fine` is that capability — a touch device never
 * matches it, so its actions are always there.
 *
 * The capability is also the only framing that does not invent vocabulary:
 * nothing in this tree lets a component ask which experience it is in
 * (`[data-experience]` is emitted for token remapping and no component reads
 * it), and a fade is a poor reason to become the first.
 *
 * `focus-within` reveals unconditionally. A keyboard reader has no pointer, and
 * the anti-pattern is hover-*only* access.
 *
 * ## Why the toast
 *
 * The same feedback `CopyBody` uses, and for the same reason: it is the house
 * pattern and the only one this app has. A button that swapped its icon for a
 * tick would be a second answer to the same question that no other copy control
 * in the product gives.
 */

import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'

export function TurnActions({
  text,
  label,
  settled,
}: {
  text: string
  label: string
  /**
   * Whether the turn this footer belongs to has finished.
   *
   * The row is drawn either way — it is the reserved space the geometry rule
   * needs — but the action is not: a Copy button under an answer the assistant
   * is still writing, or under a turn whose tools are still running, offers the
   * reader a finished thing to take away and tells them, on a touch device
   * where the row is unconditional, that the turn is over. `conversation.md`
   * closes a turn with its actions; an action that appears before the turn
   * closes is a claim about a phase (`#1363` round 4).
   */
  settled: boolean
}) {
  const copy = () => {
    copyToClipboard(text).then(
      () => {
        toast.success(`${label} copied`)
      },
      () => {
        toast.error(`Failed to copy ${label.toLowerCase()}`)
      },
    )
  }

  return (
    <div
      data-testid="conversation-turn-actions"
      className={cn(
        'flex items-center',
        // Lit by default; hidden only where the device can hover, and only until
        // it does — or until something inside takes focus.
        //
        // `hover:` rather than `group-hover/…`, and that is the whole of the
        // change `#1363` round 3 asked for. The group this used to name was
        // declared on *this* element and consumed on this element, so it
        // compiled to `X:hover X` — identical behaviour under a selector that
        // claimed an ancestor which does not exist.
        //
        // There is no ancestor to name. The action row is a **sibling** of the
        // answer's row (both are `MessageScrollerItem`s inside one fragment that
        // has no element of its own), so a group on the content row cannot reach
        // it, `peer` would match every *later* action row through the
        // general-sibling combinator, and wrapping the two would re-parent rows —
        // which `conversation.md` forbids by name, because re-parenting is what
        // remounts them. The reserved row is the hit target: it holds its height
        // whether or not it is lit, and it sits directly under the answer.
        'opacity-100',
        'pointer-fine:opacity-0',
        'pointer-fine:hover:opacity-100',
        'pointer-fine:focus-within:opacity-100',
        'transition-opacity duration-[var(--nession-motion-shell-duration)] ease-[var(--nession-motion-shell-ease)]',
      )}
      style={{ height: 'var(--nession-conversation-fold-control-height)' }}
    >
      {settled ? (
        <Button
          variant="ghost"
          size="xs"
          type="button"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => copy()}
          className="gap-1.5"
        >
          <Copy aria-hidden className="h-3.5 w-3.5" />
          Copy
        </Button>
      ) : null}
    </div>
  )
}
