import { AlertCircle, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConversationViewState } from '../hooks/useConversation';
import type { ClaudeCodeConversationResponse } from '../types';
import { clockTime } from '../model/clockTime';
import { cn } from '@/shared/lib/utils';

type Item = NonNullable<ClaudeCodeConversationResponse['items']>[number];

/**
 * How a message is presented, which is not quite the item's own `kind`.
 *
 * `kind` is the provider's reading of a record and can be `unknown`; a speaker
 * is what the transcript decided to present it as. Keeping the two separate is
 * what lets the three primitives below be named for what they render, and it
 * leaves the transcript as the single place that maps one to the other.
 */
type Speaker = 'user' | 'assistant';

/**
 * The frame the two speakers share — identity line, then a bounded bubble.
 *
 * Private: the transcript names `UserMessage` / `AssistantMessage`, and this is
 * the part they have in common. The two differ only in alignment and surface,
 * so a second copy of the frame would be two places for the meta line's
 * typography to drift.
 */
function Message({ item, speaker }: { item: Item; speaker: Speaker }) {
  const time = clockTime(item.timestamp);
  const isUser = speaker === 'user';
  return (
    <article
      data-testid="conversation-turn"
      // The item's own kind, not the speaker: this is the attribute the tests
      // and `#1120`'s fixtures read, and it must keep reporting what the
      // provider said even where the presentation normalises it.
      data-kind={item.kind}
      // Right for the user, left for Claude (#1120). Alignment carries the
      // distinction as well as the surface does, which is what makes it hold
      // for a reader who cannot rely on colour.
      className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {isUser ? 'You' : 'Claude'}
        </span>
        {time ? (
          <time dateTime={item.timestamp ?? undefined} className="text-xs text-muted-foreground">
            {time}
          </time>
        ) : null}
      </div>
      {/* The two surfaces are design roles, not colours chosen here — see
          `design/tokens/domain.json`. `#1120`'s Open Question 1 leaves their
          values to the visual pass, so this file names which role a turn plays
          and nothing more. `max-w-prose` rather than a measured width for the
          same reason: bounding a message is a reading decision, not a metric. */}
      <p
        className={cn(
          'max-w-prose whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
          isUser
            ? 'bg-[var(--conversation-user-surface)] text-[var(--conversation-user-foreground)]'
            : 'bg-[var(--conversation-assistant-surface)] text-[var(--conversation-assistant-foreground)]',
        )}
      >
        {item.text ?? ''}
      </p>
    </article>
  );
}

/**
 * What the user said (#1120).
 *
 * Named rather than a `speaker` prop at the call site so the transcript reads
 * as the conversation does, and so the two speakers can grow apart the way
 * `#1120` says they will: Claude's message is specified to render Markdown and
 * code blocks, the user's to stay plain text. That difference has no home in a
 * single branching component.
 */
export function UserMessage({ item }: { item: Item }) {
  return <Message item={item} speaker="user" />;
}

/** What Claude said (#1120). */
export function AssistantMessage({ item }: { item: Item }) {
  return <Message item={item} speaker="assistant" />;
}

/**
 * A tool call, one collapsed line by default.
 *
 * `#1005` criterion 10: tool use must not drown the conversation. Native
 * `<details>` rather than a new primitive — it is already keyboard-accessible
 * and needs no state of its own, and the summary is the line worth reading
 * whether or not the rest is open.
 *
 * Named `ToolActivity` rather than `ToolRow` because that is what it is: a tool
 * is not a participant, and the name matches the design role it consumes
 * (`conversation.tool.*`) — see `#1120`'s "Tool activity" section.
 */
export function ToolActivity({ item }: { item: Item }) {
  const tool = item.tool;
  if (!tool) {
    return null;
  }
  return (
    <details
      data-testid="conversation-tool"
      // A tool is not a participant, so it takes the activity role rather than
      // either speaker's surface. Full width on purpose (#1120): a bubble here
      // would put it in the conversation instead of beside it.
      className="rounded-md px-3 py-2 text-[var(--conversation-tool-foreground)] bg-[var(--conversation-tool-surface)]"
    >
      <summary className="flex cursor-pointer items-center gap-2 text-xs">
        <Wrench className="h-3.5 w-3.5 shrink-0" />
        <span
          className={cn(
            'font-medium',
            // The failure treatment is a conversation role too, so a transcript
            // can be re-tinted without hunting for the one place that reached
            // past the domain layer for a semantic name.
            tool.is_error && 'text-[var(--conversation-tool-error)]',
          )}
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

/**
 * The transcript, from the newest page backwards.
 *
 * The one conversation renderer, shared by the Workspace and the Peek's overlay.
 * Exported and shared rather than drawn twice because `#1120` forbids "one chat
 * visual system for Peek and another for Workspace", and a second transcript
 * renderer is exactly how that happens. It also owns its own `overflow-y-auto`,
 * which the overlay needs — it must scroll itself and never the Terminal behind
 * it.
 *
 * The kind dispatch lives here and nowhere else: `tool` is activity beside the
 * conversation, the two speakers are messages in it, and anything the provider
 * could not classify is presented as Claude's rather than dropped, because a
 * transcript that silently omits records is worse than one that shows an
 * unlabelled line.
 */
export function ConversationTranscript({
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
            <ToolActivity key={item.id} item={item} />
          ) : item.kind === 'user' ? (
            <UserMessage key={item.id} item={item} />
          ) : (
            <AssistantMessage key={item.id} item={item} />
          ),
        )
      )}
    </div>
  );
}
