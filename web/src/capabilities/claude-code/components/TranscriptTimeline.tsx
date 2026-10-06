import {
  Activity,
  Brain,
  HelpCircle,
  MessageSquare,
  Paperclip,
  Tag,
  Wrench,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { formatClockTime } from '@/shared/lib/format';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import type { ClaudeCodeTranscriptEntry } from '../types';

/**
 * A transcript's execution timeline (#1234).
 *
 * The reading order is the transcript's own, and each row says what happened
 * and when. It is deliberately **not** a raw JSON viewer: several upstream
 * records can become one row and one record can become several, and a reader of
 * this view is asking what the session did, not what Claude's storage format
 * looks like.
 *
 * ## Every kind is drawn, including the ones the conversation hides
 *
 * Reasoning, attachments, runtime events, session state and unmodelled records
 * all reach the page here. That is the difference between the two projections
 * and not an oversight: the conversation filters to turns and tools because
 * those are what a person reading a conversation wants, and this one does not
 * filter because "what did the session actually do" has no such answer.
 *
 * ## What is collapsed, and why it is not the same as hidden
 *
 * A body is behind disclosure — reasoning by default, tool payloads and
 * attachment bodies by default too, since measured they run to 126 KB and 1.2 MB
 * respectively. Collapsed is a reading posture; **hidden is a different claim**,
 * which is why a truncated body still says so on the collapsed line and an
 * unmodelled record still appears rather than being dropped.
 */

type Entry = ClaudeCodeTranscriptEntry;

/** The row's own word for what it is — never only a colour. */
function labelOf(entry: Entry): string {
  switch (entry.kind) {
    case 'message':
      return entry.source === 'human'
        ? 'Human'
        : entry.source === 'assistant'
          ? 'Assistant'
          : entry.source === 'synthetic'
            ? 'Injected context'
            : 'System';
    case 'tool':
      return entry.tool.name;
    case 'reasoning':
      return entry.reasoning_type;
    case 'attachment':
      return entry.attachment_type;
    case 'event':
      return entry.name;
    case 'metadata':
      return entry.name;
    case 'unknown':
      return entry.upstream_type ? `Unknown · ${entry.upstream_type}` : 'Unknown';
  }
}

function IconOf({ entry }: { entry: Entry }) {
  const className = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';
  switch (entry.kind) {
    case 'message':
      return <MessageSquare className={className} aria-hidden />;
    case 'tool':
      return <Wrench className={className} aria-hidden />;
    case 'reasoning':
      return <Brain className={className} aria-hidden />;
    case 'attachment':
      return <Paperclip className={className} aria-hidden />;
    case 'event':
      return <Activity className={className} aria-hidden />;
    case 'metadata':
      return <Tag className={className} aria-hidden />;
    case 'unknown':
      return <HelpCircle className={className} aria-hidden />;
  }
}

/** The body, when the entry has one. Never null for a message. */
function bodyOf(entry: Entry): string | null {
  switch (entry.kind) {
    case 'message':
      return entry.content
        .map((block) => (block.type === 'text' ? block.text : '[an unreadable block]'))
        .join('\n');
    case 'reasoning':
      return entry.text.text;
    case 'attachment':
      return entry.payload?.text ?? null;
    case 'tool':
      return entry.tool.output?.text ?? entry.tool.input?.text ?? null;
    default:
      return null;
  }
}

/** Whether a body is worth disclosing at all. */
function hasDetail(entry: Entry): boolean {
  if (entry.kind === 'tool') {
    return Boolean(entry.tool.input?.text || entry.tool.output?.text);
  }
  return bodyOf(entry) !== null;
}

/**
 * Whether a body this entry drew was cut to its ceiling.
 *
 * Asked of every kind that carries a bounded body, not only of tools. The
 * bodies that actually reach their ceiling are the other kinds — reasoning
 * measured to 126 KB and an attachment to 1.2 MB, both cut to 8 KB — so a rule
 * that only watched tools would leave the reader of a 1.2 MB attachment looking
 * at 8 KB with nothing to say it was 8 KB *of* something.
 */
function bodyWasCut(entry: Entry): boolean {
  switch (entry.kind) {
    case 'tool':
      return Boolean(entry.tool.input?.truncated || entry.tool.output?.truncated);
    case 'reasoning':
      return entry.text.truncated;
    case 'attachment':
      return entry.payload?.truncated === true;
    default:
      return false;
  }
}

/** The state a row carries on its collapsed line, if any. */
function statusOf(entry: Entry): string | null {
  const parts: string[] = [];
  if (entry.kind === 'tool') {
    parts.push(entry.tool.status);
  }
  if (bodyWasCut(entry)) {
    parts.push('truncated');
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function Row({ entry }: { entry: Entry }) {
  const time = formatClockTime(entry.timestamp);
  const status = statusOf(entry);
  const body = bodyOf(entry);
  const detail = hasDetail(entry);
  const summary = entry.kind === 'tool' ? entry.tool.summary : null;

  const head = (
    <div className="flex min-w-0 items-center gap-2">
      <IconOf entry={entry} />
      <span className={cn('shrink-0', chromeSansRole('secondary'))}>
        {labelOf(entry)}
      </span>
      {summary ? (
        <span className={cn('truncate text-muted-foreground', chromeMonoRole('metadata'))}>
          {summary}
        </span>
      ) : null}
      {status ? (
        <span className={cn('shrink-0 text-muted-foreground', chromeSansRole('metadata'))}>
          {status}
        </span>
      ) : null}
      {time ? (
        <span className={cn('ml-auto shrink-0 text-muted-foreground', chromeMonoRole('metadata'))}>
          {time}
        </span>
      ) : null}
    </div>
  );

  return (
    <li
      className="border-b border-border/50 px-3 py-2 last:border-b-0"
      data-testid="transcript-item"
      data-kind={entry.kind}
    >
      {detail ? (
        // Reasoning is collapsed like any other body: measured, it is the
        // largest block type in a real transcript, so an execution view that
        // opened it would be mostly reasoning. Collapsed is not hidden — the row
        // still says it happened, and the body is one click away.
        <Collapsible>
          <CollapsibleTrigger className="w-full text-left">{head}</CollapsibleTrigger>
          <CollapsibleContent>
            <pre
              className={cn(
                // `wrap-anywhere` rather than `break-words`, and the difference
                // is not cosmetic. `overflow-wrap: break-word` does **not**
                // reduce an element's min-content width, so the unbroken token
                // in a real tool body (base64, a long path) sized this box to
                // its full text instead of wrapping: measured, a 1.9 KB body
                // grew the timeline to 6004px inside a 992px pane. Nothing
                // looked broken, because the shell clips — the body was simply
                // unreadable past the edge. `anywhere` *is* counted in
                // min-content, so the token wraps and the box stays in its
                // pane. Not `break-all`, which would also fix the sizing but
                // breaks ordinary prose mid-word; this body is often reasoning.
                'mt-2 max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere rounded border border-border/50 bg-muted/40 p-2',
                chromeMonoRole('metadata'),
              )}
              data-testid="transcript-detail"
            >
              {body}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div>{head}</div>
      )}
    </li>
  );
}

export function TranscriptTimeline({
  items,
  onLoadOlder,
  loadingOlder = false,
  partialTail = false,
  emptyLine = 'This transcript recorded nothing.',
}: {
  items: Entry[];
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  partialTail?: boolean;
  emptyLine?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-timeline">
      <div className={cn('min-h-0 flex-1 overflow-y-auto', workspaceScrollClearanceClass)} data-testid="transcript-timeline-scroll">
        {items.length === 0 ? (
          <p className={cn('px-3 py-6 text-muted-foreground', chromeSansRole('secondary'))} data-testid="transcript-empty">
            {emptyLine}
          </p>
        ) : (
          <ul className="flex flex-col">
            {items.map((entry) => (
              <Row key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
        {onLoadOlder ? (
          <button
            type="button"
            className={cn('w-full px-3 py-2 text-muted-foreground', chromeSansRole('metadata'))}
            onClick={() => onLoadOlder()}
            data-testid="transcript-load-older"
          >
            {loadingOlder ? 'Loading…' : 'Load earlier'}
          </button>
        ) : null}
      </div>
      {partialTail ? (
        // Not an error: a transcript being appended to routinely ends in a
        // half-written record, and saying so is the difference between "this is
        // everything" and "this is everything so far".
        <p
          className={cn('px-3 py-1 text-muted-foreground', chromeSansRole('metadata'))}
          data-testid="transcript-partial"
        >
          The transcript is still being written.
        </p>
      ) : null}
    </div>
  );
}
