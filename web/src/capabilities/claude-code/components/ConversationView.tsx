import { useState, type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConversationViewState } from '../hooks/useConversation';
import type { ClaudeCodeConversationResponse } from '../types';
import { conversationLabel } from '../model/conversationLabel';
import { clockTime } from '../model/clockTime';
import { ConversationTranscript } from './ConversationTranscript';
import { cn } from '@/shared/lib/utils';

type Candidate = NonNullable<ClaudeCodeConversationResponse['candidates']>[number];

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
            {/* The title leads and the identity moves to the tooltip (#1120).
                A row's job is to be recognisable, and a UUID is not: it is the
                same string for every reader and carries no scent. It stays
                reachable here because selection still speaks it. */}
            <span className="truncate" title={candidate.claude_session_id}>
              {conversationLabel(candidate)}
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

/**
 * The candidate the open conversation refers to, for labelling it.
 *
 * The response carries both — `candidates` is populated even when one was
 * resolved (`#1005` decision 3, so a client can offer the list without a second
 * round trip) — but the *identity* shape has no display metadata, so the title
 * lives on the candidate and this is how the header reaches it. A conversation
 * whose candidate is absent still renders: `conversationLabel` has a fallback,
 * and a header is not the place to fail.
 */
function boundCandidate(view: ConversationViewState): Candidate | undefined {
  const id = view.conversation?.claude_session_id;
  return id === undefined ? undefined : view.candidates.find((c) => c.claude_session_id === id);
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
          {conversationLabel(boundCandidate(view))}
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
      <ConversationTranscript view={view} onLoadOlder={onLoadOlder} />
    </div>
  );
}
