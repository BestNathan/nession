import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import {
  ConversationListSurface,
  ConversationTranscript,
  conversationDate,
  conversationLabel,
  useAIConversation,
  type AIConversationSnapshot,
} from '@/shared/ai-conversation';
import { claudeCodeConversationAdapter } from '../../conversation/adapter';
import type { ClaudeAppData } from './model';
import { ResourceIntro, ScrollBody } from './primitives';

/** The directory's conversations, read-only. */
export function ConversationsRoute({ data }: { data: ClaudeAppData }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-conversations">
      <ResourceIntro
        eyebrow="Conversations"
        title="This working directory"
        description="Read-only history. Only an exact binding defines the current conversation."
      />
      <ScrollBody className="p-2">
        <ConversationListSurface
          snapshot={data.state.conversation.snapshot}
          onSelect={data.actions.openCandidate}
          onReload={data.state.conversation.reload}
          touch
        />
        <p className={cn('mt-4 px-2 text-muted-foreground', chromeSansRole('caption'))}>
          Opening a candidate reads it without changing the Session binding.
        </p>
      </ScrollBody>
    </div>
  );
}

function OfflineConversation() {
  return (
    <div
      data-testid="claude-app-offline"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <p className={chromeSansRole('title')}>Agent is offline</p>
      <p className={cn('max-w-sm text-muted-foreground', chromeSansRole('secondary'))}>
        This conversation cannot be refreshed. Your Terminal and Session context are
        preserved.
      </p>
    </div>
  );
}

/**
 * The honest answer when no conversation is bound to the Session.
 *
 * The provider lists conversations at the Session's working directory, so
 * these candidates are strict-cwd, not guesses. Opening one reads it; it does
 * not become current — only an exact provider binding does that.
 */
function UnboundConversation({ data }: { data: ClaudeAppData }) {
  const snapshot = data.state.conversation.snapshot;
  // Until the provider has answered the directory, "no binding" is not yet a
  // fact — it is the initial state. The list surface's own guard speaks for
  // loading, failure and unavailability; only a settled directory earns the
  // no-binding explanation.
  const settled =
    snapshot.listState === 'ready' && !snapshot.listLoading && snapshot.listError === null;
  if (!settled) {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
        <ConversationListSurface
          snapshot={snapshot}
          onSelect={data.actions.openCandidate}
          onReload={data.state.conversation.reload}
          touch
        />
      </div>
    );
  }
  return (
    <ScrollBody className="px-4 pb-6">
      <div className="py-8 text-center" data-testid="claude-app-unbound">
        <p className={chromeSansRole('title')}>No conversation linked to this Session</p>
        <p className={cn('mt-2 text-muted-foreground', chromeSansRole('secondary'))}>
          Other conversations may exist in the working directory. They are not
          automatically treated as current.
        </p>
      </div>
      <p className={cn('mb-2 px-2', chromeLabelRole())}>In this directory</p>
      <ConversationListSurface
        snapshot={snapshot}
        onSelect={data.actions.openCandidate}
        onReload={data.state.conversation.reload}
        touch
      />
      <p className={cn('mt-4 px-2 text-muted-foreground', chromeSansRole('caption'))}>
        Opening a conversation does not make it the current Session conversation.
      </p>
    </ScrollBody>
  );
}

/** The bound conversation's identity, liveness and reading surface. */
function BoundConversation({ data }: { data: ClaudeAppData }) {
  const conversation = data.state.conversation;
  const snapshot = conversation.snapshot;
  const updated = conversationDate(snapshot.conversation?.updatedAt);
  return (
    <div data-testid="conversation-open" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-4 pb-3 pt-4">
        <p className={chromeLabelRole()}>Current conversation</p>
        <h2 className={cn('mt-1 wrap-anywhere', chromeSansRole('title'))}>
          {conversationLabel(snapshot.conversation)}
        </h2>
        {/* Provider-owned liveness only. A foreground `claude` process proves
            the CLI is open, not that a turn is working (#2663, #3801), so this
            reads `snapshot.activity` and never the observed command. */}
        <div
          className={cn(
            'mt-1 flex flex-wrap items-center gap-x-2 text-muted-foreground',
            chromeSansRole('metadata'),
          )}
        >
          {snapshot.activity === 'active' ? (
            <span data-testid="conversation-state">Running now</span>
          ) : snapshot.activity === 'inactive' ? (
            <span data-testid="conversation-state">Finished</span>
          ) : null}
          {updated ? <span>{updated}</span> : null}
          <span>Read-only</span>
        </div>
        {snapshot.conversations.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            data-testid="claude-app-all-conversations"
            onClick={() => data.actions.push({ kind: 'conversations' })}
          >
            All conversations
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationTranscript
          snapshot={snapshot}
          providerLabel={claudeCodeConversationAdapter.identity.label}
          onLoadOlder={conversation.loadOlder}
          onReload={conversation.reload}
        />
      </div>
      <p
        className={cn(
          'shrink-0 border-t px-4 py-2 text-muted-foreground',
          chromeSansRole('caption'),
        )}
      >
        Read-only view. Continue this conversation in the Terminal.
      </p>
    </div>
  );
}

/**
 * The conversation root: the bound conversation, or the honest reason there is
 * none. There is no composer and no writable control — continuing the
 * conversation belongs to the Terminal.
 */
export function ConversationRootScreen({ data }: { data: ClaudeAppData }) {
  if (data.agentOffline) {
    return <OfflineConversation />;
  }
  if (data.state.conversation.snapshot.bindingId === null) {
    return <UnboundConversation data={data} />;
  }
  return <BoundConversation data={data} />;
}

/**
 * A directory conversation read on its own depth.
 *
 * It gets its own conversation runtime rather than reusing the root's: the
 * shared runtime holds **one** open conversation, and reading a candidate
 * through it would replace the bound conversation behind the pushed layer —
 * both the wrong content and a rebuilt scroll position when Back returns. The
 * runtime disposes when this depth unmounts.
 */
export function ConversationRoute({
  id,
  data,
}: {
  id: string;
  data: ClaudeAppData;
}) {
  const conversation = useAIConversation(claudeCodeConversationAdapter, {
    agentId: data.agentId,
    sessionId: data.sessionId,
  });
  const select = conversation.select;
  useEffect(() => {
    select(id);
  }, [id, select]);

  const snapshot: AIConversationSnapshot = conversation.snapshot;
  const ready = snapshot.openId === id;
  const boundId = data.state.conversation.snapshot.bindingId;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-conversation-history">
      <div className="shrink-0 border-b px-4 pb-3 pt-4">
        <h2 className={cn('wrap-anywhere', chromeSansRole('title'))}>
          {ready ? conversationLabel(snapshot.conversation) : 'Conversation'}
        </h2>
        <p className={cn('mt-1 text-muted-foreground', chromeSansRole('secondary'))}>
          Read-only history
          {id === boundId ? ' · the current Session conversation' : ' · not bound to this Session'}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {ready ? (
          <ConversationTranscript
            snapshot={snapshot}
            providerLabel={claudeCodeConversationAdapter.identity.label}
            onLoadOlder={conversation.loadOlder}
            onReload={conversation.reload}
          />
        ) : (
          <p
            className={cn('p-6 text-muted-foreground', chromeSansRole('secondary'))}
            data-testid="claude-app-conversation-loading"
          >
            Loading conversation…
          </p>
        )}
      </div>
    </div>
  );
}
