import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConversationViewState } from '../hooks/useConversation';
import type { ClaudeCodeConversationItem } from '../types';
import { conversationLabel } from '../model/conversationLabel';
import { clockTime } from '../model/clockTime';
import { previewLine } from '../model/previewLine';
import { dateBucket, type DateBucket } from '../model/dateBucket';
import { ConversationTranscript } from './ConversationTranscript';
import { cn } from '@/shared/lib/utils';

type Candidate = ClaudeCodeConversationItem;

/** The headings, and the order they are shown in — newest first. */
const BUCKET_LABELS: Record<DateBucket, string> = {
  today: 'Today',
  'previous-7-days': 'Previous 7 days',
  older: 'Older',
};
const BUCKET_ORDER: DateBucket[] = ['today', 'previous-7-days', 'older'];

/** One conversation, as a row the reader can scan and choose. */
function CandidateRow({
  candidate,
  openId,
  onSelect,
}: {
  candidate: Candidate;
  openId: string | null;
  onSelect: (claudeSessionId: string) => void;
}) {
  const time = clockTime(candidate.updated_at);
  const preview = previewLine(candidate.preview);
  return (
    <li>
      <button
        type="button"
        aria-current={openId === candidate.id ? 'true' : undefined}
        onClick={() => onSelect(candidate.id)}
        className={cn(
          'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
          'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          openId === candidate.id && 'bg-accent text-accent-foreground',
        )}
      >
        <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {/* Three ranks, and the row reads in that order (#1120): the title
            is what a person scans for, the preview says where the
            conversation got to, and the time is orientation. The title is
            `font-medium` and the preview is not, so the hierarchy survives
            without relying on the muted colour alone.

            The identity moves to the tooltip. A row's job is to be
            recognisable, and a UUID is not: it is the same string for
            every reader and carries no scent. It stays reachable because
            selection still speaks it. */}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="truncate text-sm font-medium"
            title={candidate.id}
            data-testid="conversation-candidate-title"
          >
            {conversationLabel(candidate)}
          </span>
          {/* Absent for roughly a tenth of real conversations (measured:
              14 of 120 had no prompt recorded), so the row degrades to
              title and time rather than reserving a blank second line. */}
          {preview ? (
            <span
              className="truncate text-xs text-muted-foreground"
              data-testid="conversation-candidate-preview"
            >
              {preview}
            </span>
          ) : null}
        </span>
        {time ? <span className="shrink-0 text-xs text-muted-foreground">{time}</span> : null}
      </button>
    </li>
  );
}

function CandidateList({
  candidates,
  openId,
  onSelect,
}: {
  candidates: Candidate[];
  openId: string | null;
  onSelect: (claudeSessionId: string) => void;
}) {
  // Bucketed rather than filtered per bucket, so the heading appears once
  // whatever order the provider sent: grouping consecutive runs would emit a
  // second "Older" heading if one arrived out of order, which reads as broken
  // rather than as a sort problem.
  const grouped = new Map<DateBucket, Candidate[]>();
  const undated: Candidate[] = [];
  for (const candidate of candidates) {
    const bucket = dateBucket(candidate.updated_at);
    if (bucket === null) {
      undated.push(candidate);
      continue;
    }
    const rows = grouped.get(bucket);
    if (rows) {
      rows.push(candidate);
    } else {
      grouped.set(bucket, [candidate]);
    }
  }

  const row = (candidate: Candidate) => (
    <CandidateRow
      key={candidate.id}
      candidate={candidate}
      openId={openId}
      onSelect={onSelect}
    />
  );

  return (
    <div className="space-y-4" data-testid="conversation-candidates">
      {BUCKET_ORDER.map((bucket) => {
        const rows = grouped.get(bucket);
        if (!rows || rows.length === 0) {
          return null;
        }
        return (
          <section key={bucket}>
            <h3
              className="px-2 pb-1 text-xs font-semibold text-muted-foreground"
              data-testid="conversation-bucket"
            >
              {BUCKET_LABELS[bucket]}
            </h3>
            <ul className="space-y-0.5">{rows.map(row)}</ul>
          </section>
        );
      })}
      {/* Undated rows last and unheaded. Filing them under "Older" would assert
          a recency nothing knows — the provider sorts them last for the same
          reason (`None` is not evidence of recency). */}
      {undated.length > 0 ? <ul className="space-y-0.5">{undated.map(row)}</ul> : null}
    </div>
  );
}

/** A state the provider answered with that is a message, not a conversation. */
function StateNotice({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}) {
  return (
    <p className="p-6 text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * How this section lays out, which is a width decision before it is anything
 * else — `master-detail` for Web, `push` for App (#1120).
 */
export type ConversationLayout = 'master-detail' | 'push';

/**
 * Push-layout list surface: bounded scroll owner (#1189).
 * Ref stays on this component so tsc accepts the scroll container assignment.
 */
function PushConversationList({
  candidates,
  open,
  showList,
  layout,
  onOpen,
  onBack,
}: {
  candidates: Candidate[];
  open: string | null;
  showList: boolean;
  layout: ConversationLayout;
  onOpen: (claudeSessionId: string) => void;
  onBack?: () => void;
}) {
  const listScrollRef = useRef<HTMLDivElement>(null);
  const savedListScrollTop = useRef(0);

  const rememberListScroll = () => {
    const el = listScrollRef.current;
    if (el) {
      savedListScrollTop.current = el.scrollTop;
    }
  };

  useLayoutEffect(() => {
    if (layout !== 'push' || (!showList && open !== null)) {
      return;
    }
    const el = listScrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = savedListScrollTop.current;
  }, [layout, open, showList]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listScrollRef}
        data-testid="conversation-list-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={rememberListScroll}
      >
        <ConversationList
          candidates={candidates}
          open={open}
          onOpen={(id) => {
            rememberListScroll();
            onOpen(id);
          }}
          onBack={onBack}
        />
      </div>
    </div>
  );
}

function ConversationList({
  candidates,
  open,
  onOpen,
  onBack,
}: {
  candidates: Candidate[];
  open: string | null;
  onOpen: (claudeSessionId: string) => void;
  /**
   * Returns from the pushed conversation to this list.
   *
   * Optional because it only means something in the push layout. In
   * master/detail the list is beside the conversation rather than behind it, so
   * there is nothing to return *from* and the control would be a button that
   * does nothing — which is worse than no button.
   */
  onBack?: () => void;
}) {
  return (
    <div className="space-y-3 p-4" data-testid="conversation-list">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-muted-foreground">
          Conversations in this directory
        </h2>
        {open && onBack ? (
          <Button variant="outline" size="sm" data-testid="conversation-back" onClick={onBack}>
            Back to conversation
          </Button>
        ) : null}
      </div>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No conversations to choose from.</p>
      ) : (
        <CandidateList candidates={candidates} openId={open} onSelect={onOpen} />
      )}
    </div>
  );
}

function ConversationHeader({
  view,
  onShowList,
}: {
  view: ConversationViewState;
  /** Optional for the same reason `ConversationList.onBack` is: in
   *  master/detail the list is already on screen, so "All conversations"
   *  would be a control that reveals something the reader can see. */
  onShowList?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
      <div className="min-w-0">
        {/* The label comes from the `messages` response itself — its
            `conversation` is the full item shape (#1222), so the header needs
            no join into the list by id, and the two can never disagree. */}
        <p className="truncate text-sm font-medium" title={view.conversation?.id}>
          {conversationLabel(view.conversation)}
        </p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {/* The provider's own word. `inactive` is a real, readable
              conversation whose Claude has finished (#1005 criterion 4) —
              saying so is the difference between "not live" and "broken" —
              and `unknown` makes no claim at all rather than guessing. */}
          {view.activity === 'active' ? (
            <span data-testid="conversation-state">Running now</span>
          ) : view.activity === 'inactive' ? (
            <span data-testid="conversation-state">Finished</span>
          ) : null}
          {view.partialTail ? (
            <span data-testid="conversation-partial">· still being written</span>
          ) : null}
          {view.skipped > 0 ? (
            <span data-testid="conversation-skipped">· {view.skipped} records not shown</span>
          ) : null}
        </p>
      </div>
      {view.conversations.length > 0 && onShowList ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="conversation-show-list"
          onClick={onShowList}
        >
          All conversations
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The Session's Claude conversation, or the list to choose one from.
 *
 * Every state the two units can answer with has its own rendering, and none of
 * them is a blank panel. There is no `ambiguous` and no list-level `not_found`
 * anymore (#1222): the list is the answer, an empty one included, and a
 * conversation that cannot be found is said in the detail pane, where the list
 * stays on screen to choose from.
 */
export function ConversationView({
  view,
  layout,
  onSelect,
  onLoadOlder,
  onReload,
}: {
  view: ConversationViewState;
  layout: ConversationLayout;
  onSelect: (claudeSessionId: string | null) => void;
  /** Starts an older-page fetch; answers synchronously whether one engaged. */
  onLoadOlder: () => boolean;
  onReload: () => void;
}) {
  // The list is a place the user can return to, not a fallback: it is shown
  // whenever nothing is open *and* whenever they asked to see it. Local, because
  // it is a view choice — asking the provider again would not answer it.
  const [showList, setShowList] = useState(false);
  // What is actually open is the selection, not the response: a `not_found`
  // carries no item, and deriving this from the response would bounce the
  // reader back to the list with no explanation.
  const open = view.openId;

  const renderPushList = (onBack?: () => void) => (
    <PushConversationList
      candidates={view.conversations}
      open={open}
      showList={showList}
      layout={layout}
      onOpen={(id) => {
        setShowList(false);
        onSelect(id);
      }}
      onBack={onBack}
    />
  );

  if (view.loading) {
    return <StateNotice testId="conversation-loading">Loading conversation...</StateNotice>;
  }
  if (view.error) {
    return (
      <div className="space-y-3 p-6" data-testid="conversation-error">
        <p className="text-sm text-destructive" role="alert">{view.error}</p>
        <Button variant="outline" size="sm" onClick={() => onReload()}>
          Retry
        </Button>
      </div>
    );
  }
  if (view.listState === 'unavailable') {
    return (
      <StateNotice testId="conversation-unavailable">
        The agent cannot reach this Session&rsquo;s Claude conversations.
      </StateNotice>
    );
  }
  // An empty list is a complete answer, not an error — the `conversations`
  // unit has no `not_found`, because "the list is the answer" (#1222). Only
  // when nothing is open, though: an open conversation is the `messages`
  // unit's business, and a list that shrank under it changes nothing there.
  if (view.listState === 'ready' && view.conversations.length === 0 && view.openId === null) {
    return (
      <StateNotice testId="conversation-not-found">
        No Claude conversations in this Session&rsquo;s directory.
      </StateNotice>
    );
  }
  if (layout === 'master-detail') {
    return (
      <div
        className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]"
        data-testid="conversation-master-detail"
      >
        {/* The list scrolls itself and nothing else does, so opening a
            conversation never moves the list under the reader's cursor —
            `#1120` asks for exactly that ("changes detail without losing list
            position"), and it is a property of which element owns the scroll
            rather than of anything this component tracks. */}
        <aside className="min-h-0 overflow-y-auto border-r">
          <ConversationList
            candidates={view.conversations}
            open={open}
            onOpen={(id) => onSelect(id)}
          />
        </aside>
        <main className="flex min-h-0 flex-col">
          {open === null ? (
            // The detail pane is empty, not the capability: the list beside it
            // is a complete answer, and covering it to say "nothing is open"
            // would take away the thing the reader needs to act on that.
            //
            // **Deliberately no `conversation-open` here.** That testid means "a
            // conversation is open", and putting it on an empty pane would make
            // it assert something false — which is exactly what a fixture test
            // caught when this branch was first written. It stays on the
            // content, below, so it keeps meaning what it says in both layouts.
            <StateNotice testId="conversation-nothing-open">
              Choose a conversation to read it here.
            </StateNotice>
          ) : view.messagesState === 'not_found' || view.messagesState === 'unavailable' ? (
            // Named but not there: the selection (or the binding) points at a
            // conversation the provider will not substitute anything for
            // (#1222) — say so, and leave the list beside it to choose from.
            <StateNotice testId="conversation-missing">
              That conversation is no longer in this Session&rsquo;s directory.
            </StateNotice>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-open">
              <ConversationHeader view={view} />
              <ConversationTranscript view={view} onLoadOlder={onLoadOlder} />
            </div>
          )}
        </main>
      </div>
    );
  }

  if (showList || open === null) {
    return renderPushList(() => setShowList(false));
  }

  if (view.messagesState === 'not_found' || view.messagesState === 'unavailable') {
    return (
      <div className="space-y-3 p-6" data-testid="conversation-missing">
        <p className="text-sm text-muted-foreground">
          That conversation is no longer in this Session&rsquo;s directory.
        </p>
        <Button variant="outline" size="sm" onClick={() => setShowList(true)}>
          All conversations
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-open">
      <ConversationHeader
        view={view}
        onShowList={() => setShowList(true)}
      />
      <ConversationTranscript view={view} onLoadOlder={onLoadOlder} />
    </div>
  );
}
