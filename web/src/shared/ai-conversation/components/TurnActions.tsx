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

export function TurnActions({ text, label }: { text: string; label: string }) {
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
        'group/actions flex items-center',
        // Lit by default; hidden only where the device can hover, and only until
        // it does — or until something inside takes focus.
        'opacity-100',
        'pointer-fine:opacity-0',
        'pointer-fine:group-hover/actions:opacity-100',
        'pointer-fine:focus-within:opacity-100',
        'transition-opacity duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]',
      )}
      style={{ height: 'var(--conversation-fold-control-height)' }}
    >
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
    </div>
  )
}
