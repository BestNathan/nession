/**
 * One turn's work, behind one line.
 *
 * `conversation.md`'s anatomy puts a single control above the process window —
 * "Worked" / "Worked for 12s" — and calls the arrangement out by name: outer
 * disclosure outranks inner on visibility, inner outranks outer on layout. The
 * two controls are not the same one because they answer different questions.
 * This one decides whether to look at the work at all; a group's own decides
 * which part of it.
 *
 * ## A finished turn folds, a working one does not
 *
 * The reader came for the answer. The work is what they open when the answer is
 * not enough, so a turn that has finished shows its answer and one line — that
 * is the "rest" state the pattern describes. A turn still being worked on stays
 * open, because folding something as it is written hides the only thing that is
 * happening.
 *
 * ## A button, not a `<details>`
 *
 * Folding here must not unmount what it hides. A group's `<details>` is fine
 * because its members are rows this component owns; a turn's members are rows
 * of the *transcript*, and unmounting them would take their scroll anchors,
 * their group identities and any focus inside them with it — the class of bug
 * #1386 fixed. So the rows stay mounted and are hidden by attribute, and this is
 * an ordinary button that says which way it is.
 */

import { ChevronRight } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { chromeSansRole } from '@/shared/typography/chromeRoles'

export function TurnProcess({
  label,
  open,
  onToggle,
}: {
  /** `Worked`, or `Worked for 12s` when the provider stated both ends. */
  label: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      data-testid="conversation-turn-process"
      data-open={open ? 'true' : undefined}
      // The control is what the reader presses, so it is what carries the state;
      // `aria-expanded` is the same fact a screen reader needs.
      aria-expanded={open}
      onClick={() => onToggle()}
      className={cn(
        'flex w-full items-center gap-2 text-left',
        'text-[var(--nession-conversation-tool-foreground)]',
        'transition-colors duration-[var(--nession-motion-shell-duration)] ease-[var(--nession-motion-shell-ease)]',
        'hover:text-foreground',
        chromeSansRole('metadata'),
      )}
      style={{ height: 'var(--nession-conversation-fold-control-height)' }}
    >
      <ChevronRight
        aria-hidden
        className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
      />
      <span className="truncate">{label}</span>
    </button>
  )
}
