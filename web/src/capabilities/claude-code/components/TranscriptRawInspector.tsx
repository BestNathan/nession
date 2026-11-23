import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Copy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { JsonTree } from '@/components/json/JsonTree';
import { copyJsonValue } from '@/components/json/jsonCopy';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { WorkspaceBoundedScrollport } from '@/components/ui/workspace-scrollport';
import { useTranscriptRecordText, type TranscriptRecordTextState } from '../hooks/useTranscriptRecordText';
import { parseTranscriptRecord, type ParsedTranscriptRecord } from '../model/transcriptRecord';
import { formatSize } from '../format';
import type { ClaudeCodeTranscriptRecord } from '../types';

function RawHeader({
  label,
  record,
  text,
  complete,
  variant,
  onClose,
  closeRef,
}: {
  label: string;
  record: ClaudeCodeTranscriptRecord;
  text: TranscriptRecordTextState;
  complete: boolean;
  variant: 'drawer' | 'pushed';
  onClose?: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className={cn('truncate', chromeSansRole('secondary'))} data-testid="transcript-raw-title">
          {label}
        </p>
        <p className={cn('text-muted-foreground', chromeMonoRole('caption'))}>
          byte {record.offset} · {formatSize(text.sizeBytes || record.size_bytes)}
          {complete ? '' : ' · loading'}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0"
        disabled={!complete}
        onClick={() => void copyJsonValue('record', text.raw)}
        data-testid="transcript-raw-copy"
        aria-label="Copy raw record"
      >
        <Copy className="h-3.5 w-3.5" aria-hidden />
        Copy
      </Button>
      {variant === 'drawer' && onClose ? (
        <Button
          ref={closeRef}
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => onClose()}
          data-testid="transcript-raw-close"
          aria-label="Close raw record"
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      ) : null}
    </header>
  );
}

function RawStatus({ text }: { text: TranscriptRecordTextState }) {
  if (text.status === 'loading') {
    return (
      <p
        className={cn('shrink-0 border-b px-3 py-1 text-muted-foreground', chromeSansRole('metadata'))}
        data-testid="transcript-raw-loading"
      >
        Loading the complete record… {formatSize(text.loadedBytes)}
        {text.sizeBytes > 0 ? ` of ${formatSize(text.sizeBytes)}` : ''}
      </p>
    );
  }
  if (text.status !== 'error') {
    return null;
  }
  return (
    <p
      className={cn('shrink-0 border-b px-3 py-1 text-destructive', chromeSansRole('metadata'))}
      role="alert"
      data-testid="transcript-raw-error"
    >
      {text.error}
      {text.loadedBytes > 0 && text.sizeBytes > 0
        ? ` Only ${formatSize(text.loadedBytes)} of ${formatSize(text.sizeBytes)} could be read.`
        : ''}
    </p>
  );
}

function RawBody({
  text,
  parsed,
  tab,
}: {
  text: TranscriptRecordTextState;
  parsed: ParsedTranscriptRecord | null;
  tab: 'tree' | 'text';
}) {
  const showTree = tab === 'tree' && parsed !== null && parsed.validJson;
  return (
    <WorkspaceBoundedScrollport
      className="p-3"
      viewportClassName="overflow-auto"
      data-testid="transcript-raw-scroll"
    >
      {showTree && parsed ? (
        <div data-testid="transcript-raw-tree">
          <JsonTree value={parsed.value} mode="inspector" pinRootOpen />
        </div>
      ) : text.raw !== '' ? (
        <pre
          className={cn(
            'whitespace-pre-wrap wrap-anywhere text-foreground/90',
            chromeMonoRole('metadata'),
          )}
          data-testid="transcript-raw-text"
        >
          {text.raw}
        </pre>
      ) : text.status === 'loading' ? (
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          Reading the record…
        </p>
      ) : null}
    </WorkspaceBoundedScrollport>
  );
}

/**
 * Complete Raw inspection for one record (#3726).
 *
 * The provider page may carry a record inline or as a placeholder. This view
 * assembles the complete line either way — from the page when it was carried,
 * from bounded chunks otherwise — and only then offers the JSON tree. The
 * original text is always available, including for malformed JSON, and copy
 * copies exactly the original text.
 *
 * `drawer` is the Web presentation: a bounded pane over the timeline, with its
 * own close control. `pushed` is the App presentation: the surrounding record
 * depth owns the one Back and this fills its body.
 */
export function TranscriptRawInspector({
  agentId,
  sessionId,
  record,
  variant,
  onClose,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  record: ClaudeCodeTranscriptRecord;
  variant: 'drawer' | 'pushed';
  onClose?: () => void;
}) {
  const text = useTranscriptRecordText({ agentId, sessionId, record, open: true });
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<'tree' | 'text'>('tree');

  const parsed = useMemo(
    () => (text.complete ? parseTranscriptRecord(text.raw) : null),
    [text.complete, text.raw],
  );

  useEffect(() => {
    if (variant === 'drawer') {
      closeRef.current?.focus();
    }
  }, [variant]);

  useEffect(() => {
    if (variant !== 'drawer' || !onClose) {
      return;
    }
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [onClose, variant]);

  const complete = text.status === 'ready' && text.complete;
  const label = parsed?.label ?? 'Record';

  return (
    <section
      className={cn('flex min-h-0 flex-1 flex-col bg-background', variant === 'drawer' && 'h-full')}
      data-testid="transcript-raw-inspector"
      data-variant={variant}
      aria-label={`Raw record ${label}`}
      role={variant === 'drawer' ? 'dialog' : 'region'}
      aria-modal={variant === 'drawer' ? false : undefined}
    >
      <RawHeader
        label={label}
        record={record}
        text={text}
        complete={complete}
        variant={variant}
        onClose={onClose}
        closeRef={closeRef}
      />
      <RawStatus text={text} />
      {parsed?.validJson ? (
        <div className="shrink-0 border-b px-3 py-1">
          <Tabs value={tab} onValueChange={(value) => setTab(value as 'tree' | 'text')}>
            <TabsList className={variant === 'pushed' ? 'h-auto' : undefined}>
              <TabsTrigger
                value="tree"
                className={variant === 'pushed' ? 'min-h-11' : undefined}
              >
                Tree
              </TabsTrigger>
              <TabsTrigger
                value="text"
                className={variant === 'pushed' ? 'min-h-11' : undefined}
              >
                Original text
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      ) : null}
      <RawBody text={text} parsed={parsed} tab={tab} />
    </section>
  );
}
