import { capsulePeekActionClass } from '@/shared/lib/peekActionClass';
import type { CapabilityState } from '@/product/capability';
import type { CapsuleDetail } from '@/product/terminal/capsule/types';
import { conversationLabel } from '@/shared/ai-conversation';
import { stateLine } from '../model/stateLine';
import type { ConversationSummary } from './ClaudeCodeProjection';
import { ConversationOverlay } from './ConversationOverlay';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * How many candidates the Peek lists before the Workspace takes over.
 *
 * `#1120`'s Open Question 3 leaves the number to the 375/390 visual pass rather
 * than freezing it in the product contract, so this is a starting value with
 * the reasoning attached rather than a decision: enough to recognise the one
 * you meant, few enough not to become the history browser the Workspace is for.
 */
const RECENT_LIMIT = 3;

/**
 * Claude Code beside the capsule.
 *
 * The line under the state says what is true; this says what there is to *do*
 * about it — the difference `#1046` drew between a Signal and a Peek, and the
 * reason the capability was Signal-only until the conversation existed. Before
 * it, the honest answer to "what is behind this?" was the config browser — a
 * list the Workspace already drew better. Now it is the work itself.
 *
 * Three states, because the provider has three answers and they are not
 * interchangeable:
 *
 * - **bound** — one conversation belongs to this Session, so it is named, with
 *   its recency;
 * - **unbound with candidates** — a directory full of them and no answer about
 *   which is this Session's, so the recent few are offered and none is chosen;
 *   `#1005` forbids the guess, and a Peek that guessed would be the place it
 *   happened.
 * - **none** — said plainly, rather than an empty frame that reads as a bug.
 */
export function ClaudeCodePeek({
  agentId,
  sessionId,
  conversation,
  state,
  onOpenWorkspace,
  openDetail,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  conversation: ConversationSummary;
  state: CapabilityState;
  onOpenWorkspace?: (resourceId?: string) => void;
  /** The host's approved overlay (#1120) — this capability never portals. */
  openDetail: (detail: CapsuleDetail) => void;
}) {
  const recent = conversation.candidates.slice(0, RECENT_LIMIT);

  return (
    <div data-testid="claude-code-peek-body" className="flex flex-col gap-2">
      <p className={cn('truncate text-foreground', chromeSansRole('metadata'))}>{stateLine(state)}</p>

      {conversation.title !== null ? (
        <p
          className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}
          data-testid="claude-code-peek-conversation"
        >
          {conversation.title}
          {recency(conversation.updatedAt)}
        </p>
      ) : recent.length > 0 ? (
        <>
          <p className={cn('text-muted-foreground', chromeSansRole('caption'))} data-testid="claude-code-peek-count">
            {conversation.candidates.length} conversations in this directory
          </p>
          <ul className="flex flex-col" data-testid="claude-code-peek-candidates">
            {recent.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  // Deepening carries the item, which is the one thing only this
                  // component knows — `#1046` moved that decision out of the
                  // host's footer and into the capability that made the row.
                  onClick={() => onOpenWorkspace?.(candidate.id)}
                  className={cn(
                    'w-full truncate rounded-[var(--nession-radius-control)] text-left text-muted-foreground',
                    chromeSansRole('caption'),
                    'transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  {/* The shared namer takes the canonical shape, so the
                      provider's snake_case stops here rather than leaking into
                      a shared helper. */}
                  {conversationLabel({ title: candidate.title, updatedAt: candidate.updated_at })}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))} data-testid="claude-code-peek-none">
          No conversation in this Session&rsquo;s directory
        </p>
      )}

      {/* The local action — it keeps you in the Terminal. The one that
          leaves it is the Workspace destination, and that is the host's to
          draw (#1347 SC-21), not this body's. */}
      {conversation.bound ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="claude-code-peek-view-conversation"
            onClick={() =>
              openDetail({
                title: conversation.title ?? 'Conversation',
                content: <ConversationOverlay agentId={agentId} sessionId={sessionId} />,
              })
            }
            className={capsulePeekActionClass}
          >
            View conversation
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ` · 10:06`, or nothing.
 *
 * The same rule the transcript's own timestamps follow: an unparseable or
 * absent one is dropped rather than shown raw, because an RFC 3339 string in
 * the middle of a sentence is worse than no time at all.
 */
function recency(updatedAt: string | null): string {
  if (updatedAt === null) {
    return '';
  }
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  return ` · ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
