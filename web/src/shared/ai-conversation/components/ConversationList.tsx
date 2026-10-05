/**
 * The conversations a reader may choose from.
 *
 * Three ranks per row, and the row reads in that order (#1120): the title is
 * what a person scans for, the preview says where the conversation got to, and
 * the time is orientation. The title is weight-emphasised rather than only
 * colour-differentiated, so the hierarchy survives without relying on the muted
 * tone.
 *
 * The conversation's *identity* moves to the tooltip. A row's job is to be
 * recognisable and a UUID is not — it is the same string for every reader and
 * carries no scent — but it stays reachable, because selection still speaks it.
 *
 * ## Selection, not navigation
 *
 * The row reports a choice; it does not decide what happens next. That is what
 * lets Peek and Workspace share it while doing different things with the
 * answer, and it is why `onSelect` takes an id rather than the surface taking a
 * conversation object.
 */

import { MessageSquare } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIConversationSummary } from '../model/conversation'
import { BUCKET_LABELS, bucketRows, undatedRows, type ConversationRowContent } from '../model/listing'

function CandidateRow({
  row,
  open,
  onSelect,
}: {
  row: ConversationRowContent
  open: boolean
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={open ? 'true' : undefined}
        onClick={() => onSelect(row.id)}
        className={cn(
          'flex w-full items-start gap-2 rounded-[var(--nession-radius-control)] px-2 py-1.5 text-left transition-colors',
          'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open && 'bg-accent text-accent-foreground',
        )}
      >
        <MessageSquare aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn('truncate', chromeSansRole('primary'))}
            title={row.id}
            data-testid="conversation-candidate-title"
          >
            {row.label}
          </span>
          {/* Absent for roughly a tenth of real conversations (measured: 14 of
              120 had no prompt recorded), so the row degrades to title and time
              rather than reserving a blank second line. */}
          {row.preview ? (
            <span
              className={cn('truncate text-muted-foreground', chromeSansRole('secondary'))}
              data-testid="conversation-candidate-preview"
            >
              {row.preview}
            </span>
          ) : null}
        </span>
        {row.time ? (
          <span className={cn('shrink-0 text-muted-foreground', chromeSansRole('metadata'))}>
            {row.time}
          </span>
        ) : null}
      </button>
    </li>
  )
}

export function ConversationList({
  conversations,
  openId,
  onSelect,
  now,
}: {
  conversations: AIConversationSummary[]
  openId: string | null
  onSelect: (id: string) => void
  /** The clock the buckets are measured against. Passed in so tests can stand on a boundary. */
  now?: Date
}) {
  const buckets = bucketRows(conversations, now)
  const undated = undatedRows(conversations, now)

  const row = (content: ConversationRowContent) => (
    <CandidateRow key={content.id} row={content} open={content.id === openId} onSelect={onSelect} />
  )

  return (
    <div className="space-y-4" data-testid="conversation-candidates">
      {buckets.map(({ bucket, rows }) => (
        <section key={bucket}>
          <h3
            className={cn(
              'px-2 pb-1 uppercase tracking-wide text-muted-foreground',
              chromeSansRole('metadata'),
            )}
            data-testid="conversation-bucket"
          >
            {BUCKET_LABELS[bucket]}
          </h3>
          <ul className="space-y-0.5">{rows.map(row)}</ul>
        </section>
      ))}
      {/* Undated rows last and unheaded. Filing them under "Older" would assert
          a recency nothing knows — the provider sorts them last for the same
          reason (no timestamp is not evidence of age). */}
      {undated.length > 0 ? <ul className="space-y-0.5">{undated.map(row)}</ul> : null}
    </div>
  )
}
