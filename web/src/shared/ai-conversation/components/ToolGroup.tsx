/**
 * A run of tool calls, as one row that describes the work.
 *
 * The row exists so the answer is not seven rows away from the question it
 * answers. Collapsed, it says what kind of work happened and whether any of it
 * failed; opened, it is the calls themselves, each still collapsible on its
 * own. Outer disclosure outranks inner on *visibility* and inner outranks outer
 * on *layout* — which is what the two nested `<details>` give for free.
 *
 * ## What the summary may and may not say
 *
 * Categories and counts, never tool names (`#1363`: "不堆原始 tool 名"). The
 * categories come from the adapter — a `Grep` is a *search* because Claude
 * Code's adapter says so, and this component never learns the word.
 *
 * Success is not mentioned. A row of green ticks is noise that stops meaning
 * anything; a **failure** is, because a collapsed summary that hid one would be
 * hiding the only thing in the group worth interrupting for.
 *
 * ## Bounded body
 *
 * A group with forty calls must not push the answer off screen, so the body is
 * capped and scrolls inside itself. `overscroll-behavior-y: auto` is the whole
 * wheel-handoff implementation: at the body's edge the scroll chains to the
 * transcript, natively, with no listener deciding when to forward an event.
 */

import { useRef } from 'react'
import { AlertCircle, ChevronRight, Loader } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIToolItem } from '../model/conversation'
import type { ToolGroupSummary } from '../model/grouping'
import { ToolActivity } from './ToolActivity'
import { useScrollEdges } from './useScrollEdges'

/** The mask that says a capped body continues. */
function fadeMask(up: boolean, down: boolean): string | undefined {
  if (!up && !down) {
    return undefined
  }
  const fade = 'var(--conversation-group-fade)'
  const top = up ? `transparent 0, #000 ${fade}` : `#000 0`
  const bottom = down ? `#000 calc(100% - ${fade}), transparent 100%` : `#000 100%`
  return `linear-gradient(to bottom, ${top}, ${bottom})`
}

export function ToolGroup({
  items,
  summary,
}: {
  items: AIToolItem[]
  summary: ToolGroupSummary
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(bodyRef)

  return (
    <details
      data-testid="conversation-tool-group"
      data-count={items.length}
      data-failed={summary.failed > 0 ? 'true' : undefined}
      className="group min-w-0"
    >
      <summary
        className={cn(
          'flex cursor-pointer items-center gap-2 py-1',
          'text-[var(--conversation-tool-foreground)]',
          chromeSansRole('metadata'),
        )}
      >
        <ChevronRight
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="truncate" data-testid="conversation-tool-group-summary">
          {summary.text}
        </span>
        {summary.running > 0 ? (
          <span className="flex shrink-0 items-center" data-testid="conversation-tool-group-running">
            <Loader aria-hidden className="h-3.5 w-3.5 animate-spin" />
            <span className="sr-only">{summary.running} still running</span>
          </span>
        ) : null}
        {summary.failed > 0 ? (
          <span
            className="flex shrink-0 items-center gap-1 text-[var(--conversation-tool-error)]"
            data-testid="conversation-tool-group-failed"
          >
            <AlertCircle aria-hidden className="h-3.5 w-3.5" />
            {summary.failed} failed
          </span>
        ) : null}
      </summary>
      <div
        ref={bodyRef}
        data-testid="conversation-tool-group-body"
        // `overflow-y: auto` with `overscroll-behavior-y: auto` is the handoff:
        // the wheel scrolls this body until its edge, then chains to the
        // transcript, with nothing listening for the boundary.
        className="overflow-y-auto overscroll-y-auto"
        style={{ maxHeight: 'var(--conversation-group-max-height)' }}
      >
        <div
          className="flex flex-col pe-1"
          style={{ gap: 'var(--conversation-row-gap)', maskImage: fadeMask(edges.up, edges.down) }}
        >
          {items.map((item) => (
            <ToolActivity key={item.id} item={item} />
          ))}
        </div>
      </div>
    </details>
  )
}
