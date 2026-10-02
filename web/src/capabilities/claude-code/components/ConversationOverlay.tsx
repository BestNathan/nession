import { ConversationTranscript, useAIConversation } from '@/shared/ai-conversation';
import { claudeCodeConversationAdapter } from '../conversation/adapter';

/**
 * The conversation, read from the Peek without leaving the Terminal (#1120).
 *
 * The whole point of the Peek is that "I just want to see what Claude and I
 * said" should not require a full navigation into the Workspace. This is the
 * one approved temporary detail the Peek may open, and it is deliberately not
 * a second Workspace: read-only, one level, and it closes back to the Peek it
 * came from.
 *
 * **It draws no transcript of its own** — and as of #1363 it does not own a
 * conversation runtime either. Both come from the shared framework, which is
 * what makes this surface and the Workspace the same conversation rather than
 * two implementations of one. The only Claude-specific thing here is the
 * adapter passed in.
 *
 * The runtime mounts with this component, so its polling costs nothing while
 * the overlay is closed — which is also why the overlay is the right place for
 * it: the Peek itself must stay cheap enough to appear beside a terminal.
 */
export function ConversationOverlay({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const context = agentId && sessionId ? { agentId, sessionId } : null;
  const { snapshot, loadOlder } = useAIConversation(claudeCodeConversationAdapter, context);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-overlay">
      <ConversationTranscript
        snapshot={snapshot}
        providerLabel={claudeCodeConversationAdapter.identity.label}
        onLoadOlder={loadOlder}
      />
    </div>
  );
}
