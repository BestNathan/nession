/**
 * A notice from the provider, drawn as a row of its own.
 *
 * ## Why it is not a disclosure
 *
 * Reasoning is a `<details>` because it is work the reader *can* inspect: they
 * open it when they want to know how the assistant got somewhere. A notice is
 * the opposite — there is nothing behind it, and the sentence is the whole
 * content. Wrapping it in a control would offer a reader a click that reveals
 * nothing.
 *
 * ## Why it is a row and not a banner
 *
 * A notice belongs where it happened. Lifting it out of the transcript into
 * chrome would take it away from the exchange it is about, and would make a
 * provider's sentence into Nession's claim — the row sits in the conversation
 * and says who said it by being there.
 *
 * ## The provider's words, not ours
 *
 * `item.text` is rendered as given. The model states the same rule for
 * reasoning: if the provider's text cannot be shown as it was sent, the answer
 * is a provider that says less, never this client paraphrasing what it thinks
 * happened.
 */

import { Info } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIStatusItem } from '../model/conversation'

export function StatusNotice({ item }: { item: AIStatusItem }) {
  return (
    <p
      data-testid="conversation-status"
      className={cn('flex items-start gap-2 text-muted-foreground', chromeSansRole('metadata'))}
    >
      <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{item.text}</span>
    </p>
  )
}
