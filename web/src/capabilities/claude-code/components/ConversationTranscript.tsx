import {
  AlertCircle,
  Check,
  ChevronRight,
  HelpCircle,
  Loader,
  Wrench,
  X,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { copyToClipboard } from '@/shared/lib/clipboard';
import { cn } from '@/shared/lib/utils';
import { Markdown } from '@/shared/markdown';
import type { ConversationViewState } from '../hooks/useConversation';
import { useTranscriptPullToLoad } from '../hooks/useTranscriptPullToLoad';
import { useTranscriptScroll } from '../hooks/useTranscriptScroll';
import { TranscriptPullToLoadIndicator } from './TranscriptPullToLoadIndicator';
import type { ClaudeCodeMessagesResponse } from '../types';
import { clockTime } from '../model/clockTime';

type Item = NonNullable<ClaudeCodeMessagesResponse['items']>[number];
type MessageItem = Extract<Item, { kind: 'message' }>;
type ToolItem = Extract<Item, { kind: 'tool' }>;
type Tool = ToolItem['tool'];
type Payload = NonNullable<Tool['input']>;

/**
 * The transcript, from the newest page backwards.
 *
 * Older pagination (#1190): pull-down at the top (ring fills, then release),
 * scroll-to-top fallback, and anchor preservation on prepend.
 */
export function ConversationTranscript({
  view,
  onLoadOlder,
}: {
  view: ConversationViewState;
  /** Starts an older-page fetch; answers synchronously whether one engaged. */
  onLoadOlder: () => boolean;
}) {
  const { scrollRef, topSentinelRef, onScroll, loadOlderFromPull } = useTranscriptScroll({
    conversationId: view.conversation?.id ?? null,
    itemCount: view.items.length,
    hasMore: view.hasMore,
    loadingOlder: view.loadingOlder,
    onLoadOlder,
  });

  const canPullOlder =
    view.hasMore && !view.loadingOlder && view.items.length > 0 && view.messagesState === 'ready';
  const { pullPx, progress, isPulling, atTopEdge, syncTopEdge, pullHandleHandlers, scrollHandlers } =
    useTranscriptPullToLoad({
      scrollRef,
      enabled: canPullOlder,
      onCommitLoad: loadOlderFromPull,
    });

  const handleScroll = () => {
    syncTopEdge();
    onScroll();
  };

  return (
    <div
      ref={scrollRef}
      data-testid="conversation-transcript-scroll"
      className={cn('min-h-0 flex-1 overflow-y-auto p-4 touch-pan-y', isPulling && 'touch-none overscroll-none')}
      onScroll={handleScroll}
      {...scrollHandlers}
    >
      <div
        className={cn(!isPulling && pullPx === 0 && 'translate-y-0')}
        style={pullPx > 0 ? { transform: `translateY(${pullPx}px)` } : undefined}
      >
        {canPullOlder && atTopEdge ? (
          <div
            className={cn(
              'flex min-h-11 touch-none select-none flex-col items-center justify-end overflow-hidden transition-[height] duration-75',
              isPulling ? 'cursor-grabbing' : 'cursor-grab',
            )}
            style={{ height: pullPx > 0 ? Math.max(pullPx, 44) : 44 }}
            data-testid="conversation-pull-handle"
            {...pullHandleHandlers}
          >
            {pullPx > 0 ? (
              <TranscriptPullToLoadIndicator progress={progress} />
            ) : (
              <p className="pb-1 text-[10px] text-muted-foreground" data-testid="conversation-pull-hint">
                Pull down for earlier messages
              </p>
            )}
          </div>
        ) : null}
      {view.loadingOlder ? (
        <p
          className="flex items-center justify-center gap-2 pb-3 text-xs text-muted-foreground"
          data-testid="conversation-loading-older"
          role="status"
        >
          <Loader aria-hidden className="h-3.5 w-3.5 animate-spin" />
          Loading earlier messages…
        </p>
      ) : null}
      {view.olderError ? (
        <div
          className="flex flex-wrap items-center gap-2 pb-3 text-xs text-destructive"
          data-testid="conversation-older-error"
          role="alert"
        >
          <span>{view.olderError}</span>
          <Button variant="outline" size="xs" type="button" onClick={() => loadOlderFromPull()}>
            Retry
          </Button>
        </div>
      ) : null}
      <div ref={topSentinelRef} className="h-px w-full shrink-0" aria-hidden />
      <div className="space-y-4">
        {view.items.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            This conversation has no messages yet.
          </p>
        ) : (
          view.items.map((item) => <ItemView key={item.id} item={item} />)
        )}
      </div>
      </div>
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'message':
      return item.role === 'user' ? <UserMessage item={item} /> : <AssistantMessage item={item} />;
    case 'tool':
      return <ToolActivity item={item} />;
    case 'unknown':
      // Stated, not dropped and not dressed up: a transcript that silently
      // omits records reads as a conversation that was shorter than it was.
      return <UnknownActivity />;
  }
}

/**
 * The frame both speakers share: identity line, then whichever body.
 *
 * Private, because the two speakers now differ by more than alignment. `#1167`
 * makes Claude's turn a reading column whose Markdown *is* the content, and the
 * user's a bounded surface that stays visually simpler — a difference with no
 * home in one branching component. The frame is what they still have in common,
 * and a second copy of it would be two places for the meta line to drift.
 */
function MessageFrame({
  item,
  speaker,
  children,
}: {
  item: MessageItem;
  speaker: 'user' | 'assistant';
  children: ReactNode;
}) {
  const time = clockTime(item.timestamp);
  const isUser = speaker === 'user';
  return (
    <article
      data-testid="conversation-turn"
      // The item's own kind, not the speaker. `#1120`'s tests and fixtures read
      // this attribute, and the speaker is now a separate fact the wire carries
      // on `role` — one this frame must not flatten into the other.
      data-kind={item.kind}
      data-role={item.role}
      // Claude's turn **stretches** and the user's does not, and that is a
      // correctness difference rather than an alignment preference.
      //
      // In a column flex container, `align-items: flex-start` sizes each item
      // to its *fit-content* width — which is its min-content width when that
      // is larger. A code fence's min-content width is its longest unwrapped
      // line, so `items-start` let a single long line push the whole reading
      // column 46px past its container and out of the pane. Stretching gives
      // the column a definite width, so the fence scrolls inside itself the way
      // it is supposed to. The user's bubble stays content-sized: a short
      // prompt should be a short bubble, not a full-width block.
      className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-stretch')}
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
      {children}
    </article>
  );
}

/**
 * What the user said — a bounded surface, right-aligned (#1120).
 *
 * Memoized so the three-second poll costs only what changed: the page is
 * re-read wholesale, and [`withNewest`](../model/messagePositions.ts) hands
 * back the *same object* for an item whose content is unchanged. Without this
 * the stable object would buy nothing, and every poll would re-parse every
 * message's Markdown.
 */
export const UserMessage = memo(function UserMessage({ item }: { item: MessageItem }) {
  return (
    <MessageFrame item={item} speaker="user">
      <div
        data-testid="conversation-user-body"
        // Markdown rather than `whitespace-pre-wrap`: a pasted fence or a
        // backticked path is ordinary in a prompt, and `#1167` requires both to
        // survive. The surface stays the simpler of the two — the typography
        // below is narrower than Claude's, which is what makes it so.
        className={cn(
          'max-w-prose min-w-0 rounded-lg px-3 py-2 text-sm',
          'bg-[var(--conversation-user-surface)] text-[var(--conversation-user-foreground)]',
          'prose-p:my-0 prose-pre:my-1 prose-headings:text-inherit',
        )}
      >
        <Markdown className="text-sm">{contentOf(item)}</Markdown>
      </div>
    </MessageFrame>
  );
});

/**
 * What Claude said — a reading column, not a card.
 *
 * `#1167` asks for the `rounded-lg px-3 py-2` bubble to be reviewed rather than
 * assumed to stay, and `PRINCIPLE.md` §6 ("precision, not decoration") answers
 * it: the Markdown *is* the content, and a surface drawn around prose that
 * already carries its own typography is chrome that says nothing. So there is
 * no bubble — the reading column is the message.
 */
export const AssistantMessage = memo(function AssistantMessage({ item }: { item: MessageItem }) {
  return (
    <MessageFrame item={item} speaker="assistant">
      <div
        data-testid="conversation-assistant-body"
        className={cn(
          'max-w-prose min-w-0 text-sm text-[var(--conversation-assistant-foreground)]',
          'prose-headings:mt-4 prose-headings:mb-2 prose-headings:first:mt-0',
        )}
      >
        <Markdown>{contentOf(item)}</Markdown>
      </div>
    </MessageFrame>
  );
});

/**
 * A message's blocks as Markdown source.
 *
 * A block this version does not model becomes a marker rather than vanishing:
 * its *position* is the information, and dropping it would render the message
 * as though it had said less than it did.
 */
function contentOf(item: MessageItem): string {
  return item.content
    .map((block) => (block.type === 'text' ? block.text : '_An unreadable block was here._'))
    .join('\n\n');
}

function UnknownActivity() {
  return (
    <p
      data-testid="conversation-unknown"
      className="flex items-center gap-2 text-xs text-[var(--conversation-tool-foreground)]"
    >
      <HelpCircle aria-hidden className="h-3.5 w-3.5 shrink-0" />
      An event this version does not show.
    </p>
  );
}

/**
 * A tool call, one collapsed line by default.
 *
 * `#1005` criterion 10: tool use must not drown the conversation. Native
 * `<details>` rather than a new primitive — it is already keyboard-accessible
 * and needs no state of its own, and the summary is the line worth reading
 * whether or not the rest is open.
 *
 * `PRINCIPLE.md` §4 (progressive disclosure) is the product rule: the call is
 * present as one line, and its arguments and result are there for the asking.
 */
export const ToolActivity = memo(function ToolActivity({ item }: { item: ToolItem }) {
  const { tool } = item;
  return (
    <details
      data-testid="conversation-tool"
      data-status={tool.status}
      // A tool is not a participant, so it takes the activity role rather than
      // either speaker's surface. Full width on purpose (#1120): a bubble here
      // would put it in the conversation instead of beside it.
      className="group rounded-md bg-[var(--conversation-tool-surface)] px-3 py-2 text-[var(--conversation-tool-foreground)]"
    >
      <summary className="flex cursor-pointer items-center gap-2 text-xs">
        {/* Turns as the disclosure opens. Decorative: `<details>` announces its
            own expanded state, so a second announcement would be noise. */}
        <ChevronRight
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
        />
        <Wrench aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium" data-testid="conversation-tool-name">
          {tool.name}
        </span>
        <span className="truncate">{tool.summary}</span>
        <ToolStatus status={tool.status} />
      </summary>
      <ToolDetails tool={tool} />
    </details>
  );
});

/**
 * How a call ended, said in words as well as in colour.
 *
 * The label is visually hidden rather than drawn: a collapsed row is read at a
 * glance and the glyph carries it there. But colour alone is not a status —
 * `#1167` requires success and failure to be told apart without it — so a
 * screen reader and a monochrome display both get the word.
 */
function ToolStatus({ status }: { status: Tool['status'] }) {
  const { Icon, label, className } = STATUS[status];
  return (
    <span
      className={cn('ml-auto flex shrink-0 items-center', className)}
      data-testid="conversation-tool-status"
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

const STATUS = {
  success: {
    Icon: Check,
    label: 'succeeded',
    className: 'text-[var(--conversation-tool-success)]',
  },
  error: { Icon: X, label: 'failed', className: 'text-[var(--conversation-tool-error)]' },
  running: { Icon: Loader, label: 'still running', className: '' },
  // Deliberately not "running": the provider could not tell whether a result
  // exists, and saying the call is still going would be a claim it never made.
  unknown: { Icon: HelpCircle, label: 'outcome not loaded', className: '' },
} as const;

/**
 * What the call was given, and what it produced.
 *
 * Rendered only once the disclosure is open, so a conversation full of
 * collapsed calls pays nothing for their bodies — which is the point of
 * collapsing them.
 */
export function ToolDetails({ tool }: { tool: Tool }) {
  if (!tool.input && !tool.output) {
    return (
      <p className="pt-2 text-xs opacity-80">
        {tool.status === 'running' ? 'Still running.' : 'No arguments or output were recorded.'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 pt-2">
      {tool.input ? <ToolBody label="Input" payload={tool.input} /> : null}
      {tool.output ? <ToolBody label="Output" payload={tool.output} /> : null}
    </div>
  );
}

function ToolBody({ label, payload }: { label: string; payload: Payload }) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <h4 className="text-[10px] font-semibold tracking-wide uppercase">{label}</h4>
        {payload.truncated ? (
          // Said explicitly, because a cut body is indistinguishable from a
          // short one — and the reader deciding whether they have the whole
          // answer is exactly who needs to know that they do not.
          <span className="text-[10px] opacity-80" data-testid="conversation-tool-truncated">
            truncated
          </span>
        ) : null}
        <CopyBody text={payload.text} label={label} />
      </div>
      {/* A border rather than a second surface: this body sits *inside* the
          tool's own panel, and both roles resolve to the same muted fill — so a
          fill here would be invisible. A rule is what actually says "this is a
          bounded excerpt" instead of leaving the text floating on the panel. */}
      <pre className="mt-1 max-h-64 overflow-auto rounded border border-[var(--conversation-code-border)] p-2 font-mono text-[length:var(--typography-code-size)] whitespace-pre-wrap">
        {payload.text}
      </pre>
    </section>
  );
}

/**
 * Copy one body.
 *
 * The toast is the feedback — the same house pattern `CodeBlock` uses, and the
 * only one this app has (the `<Toaster>` in `main.tsx`). A button that swapped
 * its icon to a tick for two seconds would be a second answer to the same
 * question, that no other copy control in the product gives.
 */
function CopyBody({ text, label }: { text: string; label: string }) {
  const copy = () => {
    copyToClipboard(text).then(
      () => {
        toast.success(`${label} copied`);
      },
      () => {
        toast.error(`Failed to copy ${label.toLowerCase()}`);
      },
    );
  };
  return (
    <Button
      variant="ghost"
      size="xs"
      type="button"
      className="ml-auto"
      aria-label={`Copy ${label.toLowerCase()}`}
      onClick={copy}
    >
      Copy
    </Button>
  );
}
