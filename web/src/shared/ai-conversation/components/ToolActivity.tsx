/**
 * Work the conversation did, as one row per activity.
 *
 * `#1005` criterion 10 is the product rule and `PRINCIPLE.md` §4 is why: a tool
 * call must not drown the conversation. So the call is present as **one line** —
 * what it did, and how it ended — and its arguments and result are there for the
 * asking. A reader skimming a long transcript reads the answer and the shape of
 * the work; nobody reads forty expanded cards.
 *
 * ## Native `<details>`, deliberately
 *
 * No disclosure state of this component's own. `<details>` is already
 * keyboard-accessible, already announces its expanded state, and already
 * survives a re-render without React holding a map of which row was open —
 * which matters here because the runtime replaces the item objects on every
 * refresh. A provider that could not supply `input`/`output` still gets a row;
 * a row whose body never opened costs nothing.
 *
 * ## Colour is not the status
 *
 * `#1167` requires success and failure to be told apart without colour, so the
 * outcome is a word for a screen reader and a glyph for everyone else — and
 * `unknown` is a real answer, never drawn as success. A transcript that recorded
 * a call and never a result says nothing about whether it succeeded, and
 * `#1363` names that edge case explicitly: "never fabricated as success".
 */

import { memo } from 'react'
import { Check, ChevronRight, HelpCircle, Loader, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/shared/lib/utils'
import { copyToClipboard } from '@/shared/lib/clipboard'
import { chromeLabelRole, chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIToolItem, AIToolPayload, AIToolStatus } from '../model/conversation'

const STATUS: Record<
  AIToolStatus,
  { icon: typeof Check; label: string; className: string }
> = {
  success: { icon: Check, label: 'succeeded', className: 'text-[var(--nession-conversation-tool-success)]' },
  error: { icon: X, label: 'failed', className: 'text-[var(--nession-conversation-tool-error)]' },
  running: { icon: Loader, label: 'still running', className: '' },
  // Deliberately not "running": the provider could not tell whether a result
  // exists, and saying the call is still going would be a claim it never made.
  unknown: { icon: HelpCircle, label: 'outcome not loaded', className: '' },
}

/**
 * A tool call, one collapsed line by default.
 *
 * Memoized for the same reason the messages are: the runtime hands back the
 * same object when nothing changed, and a three-second refresh must not
 * re-render (or re-parse) a transcript that said the same thing.
 */
export const ToolActivity = memo(function ToolActivity({ item }: { item: AIToolItem }) {
  const { icon: Icon, label, className } = STATUS[item.status]
  return (
    <details
      data-testid="conversation-tool"
      data-status={item.status}
      // A tool is not a participant, so it takes the activity surface rather
      // than either speaker's. Full width on purpose (#1120): a bubble here
      // would put the work *in* the conversation instead of beside it.
      className="group min-w-0 rounded-[var(--nession-radius-surface)] bg-[var(--nession-conversation-tool-surface)] px-3 py-2 text-[var(--nession-conversation-tool-foreground)]"
    >
      <summary className={cn('flex cursor-pointer items-center gap-2', chromeSansRole('metadata'))}>
        {/* Turns as the disclosure opens. Decorative: `<details>` announces its
            own expanded state, so a second announcement would be noise. */}
        <ChevronRight
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
        />
        <Wrench aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className={chromeSansRole('secondary')} data-testid="conversation-tool-name">
          {item.name}
        </span>
        {/* The adapter composed this line; the renderer only lays it out —
            `#1363`: "tool summary 的 provider-specific 提炼属于 adapter，Tool
            Activity 的布局属于 shared renderer". */}
        <span className="truncate">{item.summary}</span>
        <span
          className={cn('ml-auto flex shrink-0 items-center', className)}
          data-testid="conversation-tool-status"
        >
          <Icon aria-hidden className="h-3.5 w-3.5" />
          <span className="sr-only">{label}</span>
        </span>
      </summary>
      <ToolDetails tool={item} />
    </details>
  )
})

/**
 * What the call was given, and what it produced.
 *
 * Rendered only once the disclosure is open, so a conversation full of collapsed
 * calls pays nothing for their bodies — which is the point of collapsing them.
 */
function ToolDetails({ tool }: { tool: AIToolItem }) {
  if (!tool.input && !tool.output) {
    return (
      <p className={cn('pt-2 opacity-80', chromeSansRole('caption'))}>
        {tool.status === 'running'
          ? 'Still running.'
          : 'No arguments or output were recorded.'}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2 pt-2">
      {tool.input ? <ToolBody label="Input" payload={tool.input} /> : null}
      {tool.output ? <ToolBody label="Output" payload={tool.output} /> : null}
    </div>
  )
}

function ToolBody({ label, payload }: { label: string; payload: AIToolPayload }) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <h4 className={chromeLabelRole('caption')}>{label}</h4>
        {payload.truncated ? (
          // Said explicitly, because a cut body is indistinguishable from a
          // short one — and the reader deciding whether they have the whole
          // answer is exactly who needs to know that they do not.
          <span
            className={cn(chromeSansRole('caption'), 'opacity-80')}
            data-testid="conversation-tool-truncated"
          >
            truncated
          </span>
        ) : null}
        <CopyBody text={payload.text} label={label} />
      </div>
      {/* A bounded excerpt, so one call's output cannot push the conversation
          off screen. `overflow-auto` rather than a fade: the `truncated` marker
          already says the body continues, and a fade would need measurement to
          appear only when it means something. */}
      <pre
        className="mt-1 overflow-auto rounded-[var(--nession-radius-surface)] border border-[var(--nession-conversation-code-border)] p-2 font-mono text-[length:var(--nession-typography-code-size)] whitespace-pre-wrap"
        style={{ maxHeight: 'var(--nession-conversation-group-max-height)' }}
      >
        {payload.text}
      </pre>
    </section>
  )
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
        toast.success(`${label} copied`)
      },
      () => {
        toast.error(`Failed to copy ${label.toLowerCase()}`)
      },
    )
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      type="button"
      className="ml-auto"
      aria-label={`Copy ${label.toLowerCase()}`}
      onClick={() => copy()}
    >
      Copy
    </Button>
  )
}

/**
 * A record the shared model does not name.
 *
 * Stated, not dropped and not dressed up: a transcript that silently omits
 * records reads as a conversation that was shorter than it was (SC-10).
 */
export function UnknownActivity() {
  return (
    <p
      data-testid="conversation-unknown"
      className={cn(
        'flex items-center gap-2 text-[var(--nession-conversation-tool-foreground)]',
        chromeSansRole('metadata'),
      )}
    >
      <HelpCircle aria-hidden className="h-3.5 w-3.5 shrink-0" />
      An event this version does not show.
    </p>
  )
}
