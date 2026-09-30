import { ArrowLeft } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { clockTime } from '../model/clockTime';
import { TranscriptTimeline } from './TranscriptTimeline';
import type { ClaudeCodeTranscriptItem } from '../types';
import type { TranscriptItemsState } from '../hooks/useTranscriptItems';
import type { TranscriptsListState } from '../hooks/useTranscripts';

/**
 * What to call a transcript in the list.
 *
 * Claude titles a session but never a subagent — `ai-title` is a session-level
 * record — so the fallback is what sidechains actually get. The provider's id
 * for one is path-shaped, `<session-uuid>/agent-<id>`, and behind `truncate`
 * the tail that distinguishes one subagent from another is the first thing
 * lost, leaving rows that read alike. `agent_id` is on the contract for
 * precisely that job ("the subagent's own id, for a sidechain"), so it is the
 * fallback before the id; a primary transcript has none and keeps its id.
 */
function labelOf(transcript: ClaudeCodeTranscriptItem): string {
  return transcript.title ?? transcript.agent_id ?? transcript.id;
}

function TranscriptList({
  list,
  onSelect,
}: {
  list: TranscriptsListState;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-list">
      {list.loading ? (
        <p className={cn('px-3 py-4 text-muted-foreground', chromeSansRole('secondary'))} data-testid="transcript-list-loading">
          Loading transcripts…
        </p>
      ) : null}
      {/* `unavailable` is not an empty list: nothing has been claimed about the
          directory, so saying "none" would be a claim the provider did not make. */}
      {!list.loading && list.state === 'unavailable' ? (
        <p className={cn('px-3 py-4 text-muted-foreground', chromeSansRole('secondary'))} data-testid="transcript-unavailable">
          This Session&rsquo;s working directory cannot be established, so its transcripts cannot be listed.
        </p>
      ) : null}
      {list.error ? (
        <p className={cn('px-3 py-4 text-destructive', chromeSansRole('secondary'))} data-testid="transcript-error">
          {list.error}
        </p>
      ) : null}
      {!list.loading && !list.error && list.state === 'ready' && list.transcripts.length === 0 ? (
        <p className={cn('px-3 py-4 text-muted-foreground', chromeSansRole('secondary'))} data-testid="transcript-none">
          No transcripts at this working directory.
        </p>
      ) : null}
      <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="transcript-list-scroll">
        {list.transcripts.map((transcript: ClaudeCodeTranscriptItem) => (
          <li key={transcript.id}>
            <button
              type="button"
              className="w-full px-3 py-2 text-left hover:bg-muted/50"
              onClick={() => onSelect(transcript.id)}
              data-testid="transcript-open"
            >
              <div className="flex items-center gap-2">
                <span className={cn('truncate font-medium', chromeSansRole('secondary'))}>
                  {labelOf(transcript)}
                </span>
                {transcript.kind === 'sidechain' ? (
                  // Said in words, not only in styling: a subagent's transcript
                  // is a different kind of thing from the session's own, and the
                  // reader has to be able to tell which one they are opening.
                  <span className={cn('shrink-0 text-muted-foreground', chromeSansRole('metadata'))} data-testid="transcript-sidechain">
                    subagent
                  </span>
                ) : null}
                <span className={cn('ml-auto shrink-0 text-muted-foreground', chromeSansRole('metadata'))}>
                  {clockTime(transcript.updated_at) ?? ''}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TranscriptDetail({
  items,
  onLoadOlder,
}: {
  items: TranscriptItemsState;
  onLoadOlder: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-detail-view">
      {items.state === 'not_found' ? (
        // Final. The provider never substitutes another transcript for the id
        // that was asked for, and neither does this view.
        <p className={cn('px-3 py-4 text-muted-foreground', chromeSansRole('secondary'))} data-testid="transcript-not-found">
          That transcript is no longer here.
        </p>
      ) : null}
      {items.error ? (
        <p className={cn('px-3 py-4 text-destructive', chromeSansRole('secondary'))} data-testid="transcript-items-error">
          {items.error}
        </p>
      ) : null}
      {items.stats ? (
        // The transcript view's "is this everything?", in its own words. One
        // numbered count could not separate "understood and not drawn" from
        // "could not be read", which is why the contract replaces it.
        <p className={cn('px-3 py-1 text-muted-foreground', chromeSansRole('metadata'))} data-testid="transcript-stats">
          {items.stats.raw_records} records
          {items.stats.unknown_records > 0 ? ` · ${items.stats.unknown_records} unrecognised` : ''}
          {items.stats.invalid_records > 0 ? ` · ${items.stats.invalid_records} unreadable` : ''}
        </p>
      ) : null}
      <TranscriptTimeline
        items={items.items}
        onLoadOlder={items.hasMore ? onLoadOlder : undefined}
        loadingOlder={items.loadingOlder}
        partialTail={items.partialTail}
      />
    </div>
  );
}

/**
 * The Transcripts view (#1234): which transcripts exist, and what one did.
 *
 * Master-detail on Web and push on App, the same split `ConversationView` makes
 * from the same field for the same reason — the experience decides how much room
 * there is, and a phone has to show one thing at a time.
 *
 * ## The list is not a conversation list
 *
 * It carries the subagents too, marked as such, and it does **not** auto-open
 * anything. A transcript is chosen, never inferred: opening the session's own
 * transcript because it happens to be first would make a subagent reachable only
 * by accident, which is the selection-by-heuristic the provider's contracts
 * forbid one layer down.
 */
export function TranscriptView({
  list,
  items,
  open,
  layout,
  onSelect,
  onLoadOlder,
  onBack,
}: {
  list: TranscriptsListState;
  items: TranscriptItemsState;
  open: string | null;
  layout: 'master-detail' | 'push';
  onSelect: (id: string) => void;
  onLoadOlder: () => void;
  onBack: () => void;
}) {
  const renderList = () => <TranscriptList list={list} onSelect={onSelect} />;
  const renderDetail = () => <TranscriptDetail items={items} onLoadOlder={onLoadOlder} />;

  if (layout === 'push') {
    const showingDetail = open !== null;
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-push">
        {showingDetail ? (
          <>
            <button
              type="button"
              className={cn('flex items-center gap-1 px-3 py-2 text-muted-foreground', chromeSansRole('metadata'))}
              onClick={() => onBack()}
              data-testid="transcript-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Transcripts
            </button>
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
      <div className="flex w-72 shrink-0 flex-col border-r border-border">{renderList()}</div>
      <div className="flex min-h-0 flex-1 flex-col">
        {open === null ? (
          <p className={cn('px-3 py-4 text-muted-foreground', chromeSansRole('secondary'))} data-testid="transcript-nothing-open">
            Choose a transcript to read what the session did.
          </p>
        ) : (
          renderDetail()
        )}
      </div>
    </div>
  );
}
