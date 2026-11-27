import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { formatClockTime } from '@/shared/lib/format';
import { WorkspaceBoundedScrollport } from '@/components/ui/workspace-scrollport';
import { formatSize, transcriptLabel } from '../format';
import { parseTranscriptRecord } from '../model/transcriptRecord';
import { useTranscriptViewState } from '../hooks/useTranscriptViewState';
import { TranscriptRawInspector } from './TranscriptRawInspector';
import { TranscriptRecordDetail } from './TranscriptRecordDetail';
import { TranscriptTimeline } from './TranscriptTimeline';
import type { TranscriptRecordsState } from '../hooks/useTranscriptRecords';
import type { TranscriptsListState } from '../hooks/useTranscripts';
import type { ClaudeCodeTranscriptItem, ClaudeCodeTranscriptRecord } from '../types';

/**
 * What to call a transcript in the list. See `format.ts` — one owner, because
 * the App's pushed transcript depth names the same resource.
 */

export function TranscriptList({
  list,
  onSelect,
  touch = false,
  onRefresh,
  refreshing,
}: {
  list: TranscriptsListState;
  onSelect: (id: string) => void;
  /** The App's 44px row floor. Web keeps its tighter pointer row. */
  touch?: boolean;
  /** Manual refresh of the transcript directory (#4602). */
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-list">
      {onRefresh ? (
        <div className="flex shrink-0 items-center justify-end border-b px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-1)]">
          <RefreshButton
            onClick={() => onRefresh()}
            loading={refreshing ?? false}
            variant="ghost"
            ariaLabel="Refresh transcripts"
          />
        </div>
      ) : null}
      {list.loading ? (
        <p
          className={cn('px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-4)] text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="transcript-list-loading"
        >
          Loading transcripts…
        </p>
      ) : null}
      {/* `unavailable` is not an empty list: nothing has been claimed about the
          directory, so saying "none" would be a claim the provider did not make. */}
      {!list.loading && list.state === 'unavailable' ? (
        <p
          className={cn('px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-4)] text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="transcript-unavailable"
        >
          This Session&rsquo;s working directory cannot be established, so its transcripts cannot be listed.
        </p>
      ) : null}
      {list.error ? (
        <p
          className={cn('px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-4)] text-destructive', chromeSansRole('secondary'))}
          data-testid="transcript-error"
        >
          {list.error}
        </p>
      ) : null}
      {!list.loading && !list.error && list.state === 'ready' && list.transcripts.length === 0 ? (
        <p
          className={cn('px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-4)] text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="transcript-none"
        >
          No transcripts at this working directory.
        </p>
      ) : null}
      <WorkspaceBoundedScrollport data-testid="transcript-list-scroll">
        <ul>
        {list.transcripts.map((transcript: ClaudeCodeTranscriptItem) => (
          <li key={transcript.id}>
            <button
              type="button"
              className={cn('w-full px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)] text-left hover:bg-muted/50', touch && 'min-h-[length:var(--nession-control-md)]')}
              onClick={() => onSelect(transcript.id)}
              data-testid="transcript-open"
            >
              <div className="flex items-center gap-[var(--nession-shell-space-2)]">
                <span className={cn('truncate', chromeSansRole('secondary'))}>
                  {transcriptLabel(transcript)}
                </span>
                {transcript.kind === 'sidechain' ? (
                  <span
                    className={cn('shrink-0 text-muted-foreground', chromeSansRole('metadata'))}
                    data-testid="transcript-sidechain"
                  >
                    subagent
                  </span>
                ) : null}
                <span
                  className={cn('ml-auto shrink-0 text-muted-foreground', chromeSansRole('metadata'))}
                >
                  {formatClockTime(transcript.updated_at) ?? ''}
                </span>
              </div>
            </button>
          </li>
          ))}
        </ul>
      </WorkspaceBoundedScrollport>
    </div>
  );
}

/**
 * The App's pushed record depth.
 *
 * One record's native detail plus its Raw layer. Raw is shown in this same
 * depth — not a second overlay — so the App keeps exactly one Back per depth
 * and never compresses a desktop split into 390 px.
 */
function PushedRecord({
  record,
  rawOpen,
  onBack,
  onShowRaw,
  agentId,
  sessionId,
}: {
  record: ClaudeCodeTranscriptRecord;
  rawOpen: boolean;
  onBack: () => void;
  onShowRaw: () => void;
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const parsed = useMemo(
    () => (typeof record.raw === 'string' ? parseTranscriptRecord(record.raw) : null),
    [record.raw],
  );
  const label = parsed?.label ?? 'Record';

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-record-push">
      <button
        type="button"
        className={cn(
          'flex shrink-0 items-center gap-[var(--nession-shell-space-1)] border-b px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)] text-muted-foreground',
          chromeSansRole('metadata'),
        )}
        onClick={() => onBack()}
        data-testid="transcript-record-back"
      >
        <ArrowLeft className="size-[length:var(--nession-icon-sm)]" aria-hidden />
        Transcript
      </button>
      <WorkspaceBoundedScrollport data-testid="transcript-record-push-scroll">
        <div className="flex items-center gap-[var(--nession-shell-space-2)] border-b px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)]">
          <span className={cn('min-w-0 truncate', chromeSansRole('secondary'))}>{label}</span>
          <span className={cn('ml-auto shrink-0 text-muted-foreground', chromeMonoRole('caption'))}>
            byte {record.offset} · {formatSize(record.size_bytes)}
          </span>
        </div>
        <div className="px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)]">
          <TranscriptRecordDetail parsed={parsed} record={record} />
          <div className="mt-[var(--nession-shell-space-3)] border-t pt-[var(--nession-shell-space-2)]">
            {rawOpen ? (
              <TranscriptRawInspector
                agentId={agentId}
                sessionId={sessionId}
                record={record}
                variant="pushed"
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onShowRaw()}
                data-testid="transcript-raw-open"
              >
                Raw
              </Button>
            )}
          </div>
        </div>
      </WorkspaceBoundedScrollport>
    </div>
  );
}

/**
 * One transcript's records, with the provider's own state answers.
 *
 * Shared by the Web detail and the App's pushed transcript depth so "this
 * transcript was deleted", "this directory cannot be established", "the read
 * failed" and "nothing was recorded" stay four different sentences on both
 * surfaces. `touch` raises the record rows and their Raw actions to the App's
 * 44px floor; the Web master/detail omits it.
 */
export function TranscriptRecordsBody({
  records,
  layout,
  expandedRef,
  onToggleRecord,
  onOpenRecord,
  onOpenRaw,
  onLoadOlder,
  onReload,
  touch = false,
}: {
  records: TranscriptRecordsState;
  layout: 'master-detail' | 'push';
  expandedRef: string | null;
  onToggleRecord: (recordRef: string) => void;
  onOpenRecord: (record: ClaudeCodeTranscriptRecord) => void;
  onOpenRaw: (record: ClaudeCodeTranscriptRecord) => void;
  onLoadOlder: () => void;
  onReload: () => void;
  touch?: boolean;
}) {
  const showRecords = records.state === 'ready' || records.records.length > 0;
  return (
    <>
      {records.state === 'not_found' ? (
        <p
          className={cn('px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-4)] text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="transcript-not-found"
        >
          That transcript is no longer here.
        </p>
      ) : null}
      {records.state === 'unavailable' ? (
        <p
          className={cn('px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-4)] text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="transcript-items-unavailable"
        >
          This Session&rsquo;s working directory cannot be established, so the transcript cannot be read.
        </p>
      ) : null}
      {records.error ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-[var(--nession-shell-space-2)] px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)]"
          data-testid="transcript-items-error"
        >
          <p className={cn('text-destructive', chromeSansRole('secondary'))}>{records.error}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => onReload()}>
            Reload
          </Button>
        </div>
      ) : null}
      {records.loading && records.records.length === 0 ? (
        <p
          className={cn('px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-4)] text-muted-foreground', chromeSansRole('secondary'))}
          data-testid="transcript-items-loading"
        >
          Loading the transcript…
        </p>
      ) : null}
      {showRecords ? (
        <TranscriptTimeline
          records={records.records}
          layout={layout}
          expandedRef={expandedRef}
          onToggleRecord={onToggleRecord}
          onOpenRecord={onOpenRecord}
          onOpenRaw={onOpenRaw}
          onLoadOlder={records.hasMore ? onLoadOlder : undefined}
          loadingOlder={records.loadingOlder}
          partialTail={records.partialTail}
          touch={touch}
        />
      ) : null}
    </>
  );
}

function TranscriptDetail({
  records,
  layout,
  expandedRef,
  onToggleRecord,
  onOpenRecord,
  onOpenRaw,
  onLoadOlder,
  onReload,
  rawRecord,
  onCloseRaw,
  agentId,
  sessionId,
}: {
  records: TranscriptRecordsState;
  layout: 'master-detail' | 'push';
  expandedRef: string | null;
  onToggleRecord: (recordRef: string) => void;
  onOpenRecord: (record: ClaudeCodeTranscriptRecord) => void;
  onOpenRaw: (record: ClaudeCodeTranscriptRecord) => void;
  onLoadOlder: () => void;
  onReload: () => void;
  rawRecord: ClaudeCodeTranscriptRecord | null;
  onCloseRaw: () => void;
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="transcript-detail-view">
      <TranscriptRecordsBody
        records={records}
        layout={layout}
        expandedRef={expandedRef}
        onToggleRecord={onToggleRecord}
        onOpenRecord={onOpenRecord}
        onOpenRaw={onOpenRaw}
        onLoadOlder={onLoadOlder}
        onReload={onReload}
      />
      {layout === 'master-detail' && rawRecord ? (
        <div
          className="absolute inset-y-0 right-0 z-10 flex w-[min(var(--nession-overlay-standard-max-width),100%)] flex-col border-l bg-background shadow-[var(--nession-elevation-floating)]"
          data-testid="transcript-raw-drawer"
        >
          <TranscriptRawInspector
            agentId={agentId}
            sessionId={sessionId}
            record={rawRecord}
            variant="drawer"
            onClose={onCloseRaw}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Transcripts view (#1234, revised by #3726): which transcripts exist, and
 * the complete raw record timeline of one.
 *
 * Master-detail on Web and push on App, the same split `ConversationView` makes
 * from the same field for the same reason — the experience decides how much
 * room there is, and a phone shows one thing at a time.
 *
 * ## The list is not a conversation list
 *
 * It carries the subagents too, marked as such, and it does **not** auto-open
 * anything. A transcript is chosen, never inferred.
 *
 * ## Selection changes close stale detail and Raw
 *
 * Opening a different transcript — or changing Session/Agent — clears the
 * expanded row, the pushed depth and the Raw inspector. An answer about the
 * previous transcript must not remain readable under the new transcript's
 * header.
 */
export function TranscriptView({
  list,
  records,
  open,
  layout,
  agentId,
  sessionId,
  onSelect,
  onLoadOlder,
  onReload,
  onBack,
  onRefresh,
  refreshing,
}: {
  list: TranscriptsListState;
  records: TranscriptRecordsState;
  open: string | null;
  layout: 'master-detail' | 'push';
  agentId: string | undefined;
  sessionId: string | undefined;
  onSelect: (id: string) => void;
  onLoadOlder: () => void;
  onReload: () => void;
  onBack: () => void;
  /** Manual refresh of the transcript directory (#4602). */
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const view = useTranscriptViewState({ open, agentId, sessionId });

  const renderList = () => (
    <TranscriptList list={list} onSelect={onSelect} onRefresh={onRefresh} refreshing={refreshing} />
  );
  const renderDetail = () =>
    view.pushedRecord && layout === 'push' ? (
      <PushedRecord
        record={view.pushedRecord}
        rawOpen={view.pushedRawOpen}
        onBack={view.closePushedRecord}
        onShowRaw={view.showPushedRaw}
        agentId={agentId}
        sessionId={sessionId}
      />
    ) : (
      <TranscriptDetail
        records={records}
        layout={layout}
        expandedRef={view.expandedRef}
        onToggleRecord={view.toggleRecord}
        onOpenRecord={view.openRecord}
        onOpenRaw={(record) => view.openRaw(record, layout)}
        onLoadOlder={onLoadOlder}
        onReload={onReload}
        rawRecord={view.rawRecord}
        onCloseRaw={view.closeRaw}
        agentId={agentId}
        sessionId={sessionId}
      />
    );

  if (layout === 'push') {
    const showingDetail = open !== null;
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-push">
        {showingDetail ? (
          <>
            {view.pushedRecord === null ? (
              <button
                type="button"
                className={cn(
                  'flex items-center gap-[var(--nession-shell-space-1)] px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)] text-muted-foreground',
                  chromeSansRole('metadata'),
                )}
                onClick={() => onBack()}
                data-testid="transcript-back"
              >
                <ArrowLeft className="size-[length:var(--nession-icon-sm)]" aria-hidden />
                Transcripts
              </button>
            ) : null}
            {renderDetail()}
          </>
        ) : (
          renderList()
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-row" data-testid="transcript-master-detail">
      <div className="flex w-[length:var(--nession-transcript-list-width)] shrink-0 flex-col border-r border-border">{renderList()}</div>
      <div className="flex min-h-0 flex-1 flex-col">
        {open === null ? (
          <p
            className={cn('px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-4)] text-muted-foreground', chromeSansRole('secondary'))}
            data-testid="transcript-nothing-open"
          >
            Choose a transcript to read what the session did.
          </p>
        ) : (
          <TranscriptDetail
            records={records}
            layout={layout}
            expandedRef={view.expandedRef}
            onToggleRecord={view.toggleRecord}
            onOpenRecord={view.openRecord}
            onOpenRaw={(record) => view.openRaw(record, layout)}
            onLoadOlder={onLoadOlder}
            onReload={onReload}
            rawRecord={view.rawRecord}
            onCloseRaw={view.closeRaw}
            agentId={agentId}
            sessionId={sessionId}
          />
        )}
      </div>
    </div>
  );
}
