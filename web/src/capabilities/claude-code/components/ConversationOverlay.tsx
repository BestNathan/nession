import { useConversation } from '../hooks/useConversation';
import { ConversationTranscript } from './ConversationTranscript';

/**
 * The conversation, read from the Peek without leaving the Terminal (#1120).
 *
 * The whole point of the Peek is that "I just want to see what Claude and I
 * said" should not require a full navigation into the Workspace. This is the
 * one approved temporary detail the Peek may open, and it is deliberately not
 * a second Workspace: read-only, one level, and it closes back to the Peek it
 * came from.
 *
 * **It draws no transcript of its own.** `ConversationTranscript` is the one
 * conversation renderer, reused here from the Workspace view, so the two
 * surfaces cannot drift into two visual languages — the failure mode `#1120`
 * names, and the reason this was built after the shared renderer rather than
 * beside it.
 *
 * `useConversation` is the capability's own hook and mounts with this
 * component, so its polling costs nothing while the overlay is closed. That is
 * also why the overlay is the right place for it: the Peek itself must stay
 * cheap enough to appear beside a terminal.
 */
export function ConversationOverlay({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const { view, loadOlder } = useConversation({ agentId, sessionId });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-overlay">
      <ConversationTranscript view={view} onLoadOlder={() => loadOlder()} />
    </div>
  );
}
