import { useState, type ReactNode } from 'react';
import { AlertCircle, MessageSquare, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConversationViewState } from '../hooks/useConversation';
import type { ClaudeCodeConversationResponse } from '../types';
import { cn } from '@/shared/lib/utils';

type Item = NonNullable<ClaudeCodeConversationResponse['items']>[number];
type Candidate = NonNullable<ClaudeCodeConversationResponse['candidates']>[number];

/**
 * A record's own timestamp, as a clock time.
 *
 * Short on purpose: the reading order is the transcript's order, so the
 * timestamp is orientation rather than information. Anything unparseable is
 * dropped rather than shown raw — an RFC 3339 string in the middle of a
 * sentence is worse than no time at all.
 */
function clockTime(timestamp: string | null | undefined): string | null {
  if (!timestamp) {
    return null;
  }
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function Turn({ item }: { item: Item }) {
  const time = clockTime(item.timestamp);
  return (
    <article data-testid="conversation-turn" data-kind={item.kind} className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {item.kind === 'user' ? 'You' : 'Claude'}
        </span>
        {time ? (
          <time dateTime={item.timestamp ?? undefined} className="text-xs text-muted-foreground">
            {time}
          </time>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-sm">{item.text ?? ''}</p>
    </article>
  );
}

/**
 * A tool call, one collapsed line by default.
 *
 * `#1005` criterion 10: tool use must not drown the conversation. Native
 * `<details>` rather than a new primitive — it is already keyboard-accessible
 * and needs no state of its own, and the summary is the line worth reading
 * whether or not the rest is open.
 */
function ToolRow({ item }: { item: Item }) {
  const tool = item.tool;
  if (!tool) {
    return null;
  }
  return (
    <details data-testid="conversation-tool" className="rounded-md border px-3 py-2">
      <summary className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Wrench className="h-3.5 w-3.5 shrink-0" />
        <span
          className={cn('font-medium', tool.is_error && 'text-destructive')}
          data-testid="conversation-tool-name"
        >
          {tool.name}
        </span>
        <span className="truncate">{tool.summary}</span>
        {tool.truncated ? <span className="shrink-0">(truncated)</span> : null}
      </summary>
      {item.text ? <p className="whitespace-pre-wrap pt-2 text-xs">{item.text}</p> : null}
    </details>
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
  return (
    <ul className="space-y-0.5" data-testid="conversation-candidates">
      {candidates.map((candidate) => (
        <li key={candidate.claude_session_id}>
          <button
            type="button"
            aria-current={openId === candidate.claude_session_id ? 'true' : undefined}
            onClick={() => onSelect(candidate.claude_session_id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              openId === candidate.claude_session_id && 'bg-accent text-accent-foreground',
            )}
          >
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate" title={candidate.claude_session_id}>
              {candidate.claude_session_id}
            </span>
            {clockTime(candidate.updated_at) ? (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {clockTime(candidate.updated_at)}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
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

function ConversationList({
  candidates,
  open,
  onOpen,
  onBack,
}: {
  candidates: Candidate[];
  open: string | null;
  onOpen: (claudeSessionId: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3 p-4" data-testid="conversation-list">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-muted-foreground">
          Conversations in this directory
        </h2>
        {open ? (
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

function ConversationBody({
  view,
  onLoadOlder,
}: {
  view: ConversationViewState;
  onLoadOlder: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {view.hasMore ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="conversation-load-older"
          disabled={view.loadingOlder}
          onClick={() => onLoadOlder()}
        >
          {view.loadingOlder ? 'Loading...' : 'Load older'}
        </Button>
      ) : null}
      {view.items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4" />
          This conversation has no messages yet.
        </p>
      ) : (
        view.items.map((item) =>
          item.kind === 'tool' ? (
            <ToolRow key={item.id} item={item} />
          ) : (
            <Turn key={item.id} item={item} />
          ),
        )
      )}
    </div>
  );
}

function ConversationHeader({
  view,
  onShowList,
}: {
  view: ConversationViewState;
  onShowList: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium" title={view.conversation?.claude_session_id}>
          {view.conversation?.claude_session_id}
        </p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {/* The provider's own word. `inactive` is a real, readable
              conversation whose Claude has finished (#1005 criterion 4) —
              saying so is the difference between "not live" and "broken". */}
          <span data-testid="conversation-state">
            {view.state === 'ready' ? 'Running now' : 'Finished'}
          </span>
          {view.partialTail ? (
            <span data-testid="conversation-partial">· still being written</span>
          ) : null}
          {view.skipped > 0 ? (
            <span data-testid="conversation-skipped">· {view.skipped} records not shown</span>
          ) : null}
        </p>
      </div>
      {view.candidates.length > 0 ? (
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
 * Every state the provider can answer with has its own rendering, and none of
 * them is a blank panel: `ambiguous` and `not_found` are answers a user acts on,
 * not failures (`#1005` criterion 2 keeps the list as the stable entry point).
 */
export function ConversationView({
  view,
  onSelect,
  onLoadOlder,
  onReload,
}: {
  view: ConversationViewState;
  onSelect: (claudeSessionId: string | null) => void;
  onLoadOlder: () => void;
  onReload: () => void;
}) {
  // The list is a place the user can return to, not a fallback: it is shown
  // whenever nothing is open *and* whenever they asked to see it. Local, because
  // it is a view choice — asking the provider again would not answer it.
  const [showList, setShowList] = useState(false);
  // What is actually open, which is the provider's answer — not the client's
  // request. They agree whenever a selection succeeded, and the provider's is
  // the one that is true when it did not.
  const open = view.conversation?.claude_session_id ?? null;

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
  if (view.state === 'unavailable') {
    return (
      <StateNotice testId="conversation-unavailable">
        The agent cannot reach this Session&rsquo;s Claude conversations.
      </StateNotice>
    );
  }
  if (view.state === 'not_found') {
    return (
      <StateNotice testId="conversation-not-found">
        No Claude conversations in this Session&rsquo;s directory.
      </StateNotice>
    );
  }
  if (showList || open === null) {
    return (
      <ConversationList
        candidates={view.candidates}
        open={open}
        onOpen={(id) => {
          setShowList(false);
          onSelect(id);
        }}
        onBack={() => setShowList(false)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-open">
      <ConversationHeader view={view} onShowList={() => setShowList(true)} />
      <ConversationBody view={view} onLoadOlder={onLoadOlder} />
    </div>
  );
}
