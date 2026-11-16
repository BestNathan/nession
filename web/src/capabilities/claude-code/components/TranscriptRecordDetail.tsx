import { Brain, CornerDownRight, Image as ImageIcon, Wrench } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { formatSize } from '../format';
import type { ClaudeTranscriptBlock, ParsedTranscriptRecord } from '../model/transcriptRecord';
import type { ClaudeCodeTranscriptRecord } from '../types';

/** One block inside a message row. Every block is drawn, none filters another. */
function Block({ block }: { block: ClaudeTranscriptBlock }) {
  const iconClass = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';
  const bodyClass = cn(
    'mt-1 max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-[var(--nession-radius-surface)] border border-border/50 bg-muted/40 p-2',
    chromeMonoRole('metadata'),
  );

  switch (block.kind) {
    case 'text':
      return <pre className={bodyClass}>{block.text}</pre>;
    case 'thinking':
      return (
        <section data-testid="transcript-block" data-kind="thinking" className="min-w-0">
          <div className={cn('flex items-center gap-1.5 text-muted-foreground', chromeSansRole('metadata'))}>
            <Brain className={iconClass} aria-hidden />
            Thinking
          </div>
          <pre className={bodyClass}>{block.text}</pre>
        </section>
      );
    case 'tool_use':
      return (
        <section data-testid="transcript-block" data-kind="tool_use" className="min-w-0">
          <div className={cn('flex min-w-0 items-center gap-1.5', chromeSansRole('secondary'))}>
            <Wrench className={iconClass} aria-hidden />
            <span className="truncate">{block.name}</span>
            {block.callId ? (
              <span className={cn('truncate text-muted-foreground', chromeMonoRole('caption'))}>
                {block.callId}
              </span>
            ) : null}
          </div>
          <pre className={bodyClass}>{block.input}</pre>
        </section>
      );
    case 'tool_result':
      return (
        <section data-testid="transcript-block" data-kind="tool_result" className="min-w-0">
          <div className={cn('flex min-w-0 items-center gap-1.5', chromeSansRole('secondary'))}>
            <CornerDownRight className={iconClass} aria-hidden />
            <span className="truncate">Tool result</span>
            {block.callId ? (
              <span className={cn('truncate text-muted-foreground', chromeMonoRole('caption'))}>
                {block.callId}
              </span>
            ) : null}
            {block.isError ? (
              <span className={cn('shrink-0 text-destructive', chromeSansRole('metadata'))}>error</span>
            ) : null}
          </div>
          <pre className={bodyClass}>{block.text}</pre>
        </section>
      );
    case 'image':
      return (
        <div
          data-testid="transcript-block"
          data-kind="image"
          className={cn('flex items-center gap-1.5 text-muted-foreground', chromeSansRole('metadata'))}
        >
          <ImageIcon className={iconClass} aria-hidden />
          Image{block.mediaType ? ` · ${block.mediaType}` : ''}
        </div>
      );
    case 'other':
      return (
        <section data-testid="transcript-block" data-kind="other" className="min-w-0">
          <div className={cn('flex items-center gap-1.5', chromeSansRole('metadata'))}>
            <span className={cn('text-muted-foreground', chromeMonoRole('caption'))}>
              {block.blockType}
            </span>
          </div>
          <pre className={bodyClass}>{block.preview}</pre>
        </section>
      );
  }
}

/**
 * Native detail for any record, including system, metadata, unknown and
 * malformed rows.
 *
 * This is deliberately *not* the Raw inspector: it is the readable view of what
 * the record says. Raw is the separate, complete JSON-tree/text layer, and the
 * two actions never hide each other.
 */
export function TranscriptRecordDetail({
  parsed,
  record,
}: {
  parsed: ParsedTranscriptRecord | null;
  record: ClaudeCodeTranscriptRecord;
}) {
  if (parsed === null) {
    return (
      <div
        className={cn('mt-2 rounded-[var(--nession-radius-surface)] border border-border/50 bg-muted/30 p-2 text-muted-foreground', chromeSansRole('metadata'))}
        data-testid="transcript-record-not-carried"
      >
        This {formatSize(record.size_bytes)} record was not carried in the page. Open Raw to read it.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2" data-testid="transcript-record-detail" data-kind={parsed.kind}>
      {parsed.kind === 'invalid' ? (
        <pre
          className={cn(
            'max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-[var(--nession-radius-surface)] border border-border/50 bg-muted/40 p-2 text-muted-foreground',
            chromeMonoRole('metadata'),
          )}
          data-testid="transcript-invalid-preview"
        >
          {record.raw ?? ''}
        </pre>
      ) : null}

      {parsed.blocks.map((block, index) => (
        <Block key={`${block.kind}-${index}`} block={block} />
      ))}

      {parsed.fields.length > 0 ? (
        <dl className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
          {parsed.fields.map((field) => (
            <div key={field.label} className="contents">
              <dt className={cn('truncate text-muted-foreground', chromeMonoRole('caption'))}>
                {field.label}
              </dt>
              <dd className={cn('min-w-0 truncate', chromeMonoRole('metadata'))} title={field.value}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
