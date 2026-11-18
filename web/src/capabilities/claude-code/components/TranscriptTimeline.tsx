import { useMemo } from 'react';
import {
  Activity,
  Braces,
  MessageSquare,
  Paperclip,
  Tag,
  UserRound,
} from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { formatClockTime } from '@/shared/lib/format';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { parseTranscriptRecord, type ParsedTranscriptRecord } from '../model/transcriptRecord';
import { formatSize } from '../format';
import { TranscriptRecordDetail } from './TranscriptRecordDetail';
import type { ClaudeCodeTranscriptRecord } from '../types';

/**
 * A transcript's complete record timeline (#3726).
 *
 * One source line is one row, always — recognized, unknown, malformed or too
 * large for the page. A row's native detail is disclosure *inside* that row;
 * Raw is a separate action on the same row. No record is filtered because a
 * decoder did not understand it, and no parser-state badge is drawn.
 *
 * On Web (`master-detail`) a row expands in place. On App (`push`) clicking a
 * row pushes its detail depth, where the same native detail and Raw live; the
 * surface keeps one Back per depth rather than compressing a desktop split.
 */
function RowIcon({ parsed }: { parsed: ParsedTranscriptRecord | null }) {
  const className = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';
  switch (parsed?.kind) {
    case 'user':
      return <UserRound className={className} aria-hidden />;
    case 'assistant':
      return <MessageSquare className={className} aria-hidden />;
    case 'system':
    case 'event':
      return <Activity className={className} aria-hidden />;
    case 'attachment':
      return <Paperclip className={className} aria-hidden />;
    case 'metadata':
      return <Tag className={className} aria-hidden />;
    default:
      return <Braces className={className} aria-hidden />;
  }
}

function previewOf(
  parsed: ParsedTranscriptRecord | null,
  record: ClaudeCodeTranscriptRecord,
): string {
  if (parsed?.preview) {
    return parsed.preview;
  }
  if (parsed === null) {
    return `${formatSize(record.size_bytes)} record — open Raw to read it`;
  }
  return `${formatSize(record.size_bytes)}`;
}

function RecordRow({
  record,
  layout,
  expanded,
  onToggle,
  onOpenRecord,
  onOpenRaw,
  touch = false,
}: {
  record: ClaudeCodeTranscriptRecord;
  layout: 'master-detail' | 'push';
  expanded: boolean;
  onToggle: () => void;
  onOpenRecord: () => void;
  onOpenRaw: () => void;
  touch?: boolean;
}) {
  const parsed = useMemo(
    () => (typeof record.raw === 'string' ? parseTranscriptRecord(record.raw) : null),
    [record.raw],
  );
  const time = formatClockTime(parsed?.timestamp ?? null);
  const label = parsed?.label ?? 'Record';
  // A call and its result are two source rows; the shared id is what links them
  // visually without consuming either row.
  const linkedCallId =
    parsed?.blocks.find(
      (block) => block.kind === 'tool_use' || block.kind === 'tool_result',
    )?.callId ?? null;

  return (
    <li
      className="border-b border-border/50 last:border-b-0"
      data-testid="transcript-record"
      data-kind={parsed?.kind ?? 'uncarried'}
    >
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-muted/50',
            touch && 'min-h-11',
          )}
          aria-expanded={layout === 'master-detail' ? expanded : undefined}
          onClick={() => (layout === 'push' ? onOpenRecord() : onToggle())}
          data-testid="transcript-record-open"
        >
          <RowIcon parsed={parsed} />
          <span className={cn('shrink-0', chromeSansRole('secondary'))}>{label}</span>
          <span className={cn('min-w-0 truncate text-muted-foreground', chromeMonoRole('metadata'))}>
            {previewOf(parsed, record)}
          </span>
          {linkedCallId ? (
            <span
              className={cn('shrink-0 text-muted-foreground', chromeMonoRole('caption'))}
              data-testid="transcript-call-id"
            >
              {linkedCallId}
            </span>
          ) : null}
          {time ? (
            <span
              className={cn(
                'ml-auto shrink-0 text-muted-foreground',
                chromeMonoRole('metadata'),
              )}
            >
              {time}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={cn(
            'my-1 shrink-0 rounded-[var(--nession-radius-control)] px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground',
            touch && 'min-h-11 min-w-11',
            chromeSansRole('metadata'),
          )}
          onClick={() => onOpenRaw()}
          aria-label={`Raw record ${label}`}
          data-testid="transcript-raw-open"
        >
          Raw
        </button>
      </div>
      {expanded ? (
        <div className="min-w-0 px-3 pb-2">
          <TranscriptRecordDetail parsed={parsed} record={record} />
        </div>
      ) : null}
    </li>
  );
}

export function TranscriptTimeline({
  records,
  layout,
  expandedRef,
  onToggleRecord,
  onOpenRecord,
  onOpenRaw,
  onLoadOlder,
  loadingOlder = false,
  partialTail = false,
  emptyLine = 'This transcript recorded nothing.',
  touch = false,
}: {
  records: ClaudeCodeTranscriptRecord[];
  layout: 'master-detail' | 'push';
  expandedRef: string | null;
  onToggleRecord: (recordRef: string) => void;
  onOpenRecord: (record: ClaudeCodeTranscriptRecord) => void;
  onOpenRaw: (record: ClaudeCodeTranscriptRecord) => void;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  partialTail?: boolean;
  emptyLine?: string;
  /** The App's 44px touch floor for the row and its Raw action. */
  touch?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-timeline">
      <div
        className={cn('min-h-0 flex-1 overflow-y-auto', workspaceScrollClearanceClass)}
        data-testid="transcript-timeline-scroll"
      >
        {records.length === 0 ? (
          <p
            className={cn('px-3 py-6 text-muted-foreground', chromeSansRole('secondary'))}
            data-testid="transcript-empty"
          >
            {emptyLine}
          </p>
        ) : (
          <ul className="flex flex-col">
            {records.map((record) => (
              <RecordRow
                key={record.record_ref}
                record={record}
                layout={layout}
                expanded={expandedRef === record.record_ref}
                onToggle={() => onToggleRecord(record.record_ref)}
                onOpenRecord={() => onOpenRecord(record)}
                onOpenRaw={() => onOpenRaw(record)}
                touch={touch}
              />
            ))}
          </ul>
        )}
        {onLoadOlder ? (
          <button
            type="button"
            className={cn(
              'w-full px-3 py-2 text-muted-foreground',
              touch && 'min-h-11',
              chromeSansRole('metadata'),
            )}
            onClick={() => onLoadOlder()}
            data-testid="transcript-load-older"
          >
            {loadingOlder ? 'Loading…' : 'Load earlier'}
          </button>
        ) : null}
      </div>
      {partialTail ? (
        <p
          className={cn('px-3 py-1 text-muted-foreground', chromeSansRole('metadata'))}
          data-testid="transcript-partial"
        >
          The transcript is still being written.
        </p>
      ) : null}
      <span className="sr-only" data-testid="transcript-record-count">
        {records.length}
      </span>
      <span className="sr-only" data-testid="transcript-layout">
        {layout}
      </span>
    </div>
  );
}
