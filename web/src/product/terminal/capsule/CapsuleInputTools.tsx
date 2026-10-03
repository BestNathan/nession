import { CapsuleHistoryPopover } from '@/product/terminal/capsule/CapsuleHistoryPopover';
import { CapsuleInputActionButtons } from '@/product/terminal/capsule/CapsuleInputActionButtons';
import {
  capsuleControlRowClass,
  capsuleIconButtonClass,
} from '@/product/terminal/capsule/capsuleStyles';
import { CapsuleIconVisual } from '@/product/terminal/capsule/CapsuleIconVisual';
import { Plus } from 'lucide-react';
import {
  ContextDisclosureMenu,
  type SensedCapabilityItem,
} from '@/product/capability/components/ContextDisclosureMenu';
import { cn } from '@/shared/lib/utils';
import type {
  CapsuleCapabilityDisclosure,
} from '@/product/terminal/capsule/types';
import { WorkRing } from '@/product/terminal/capsule/WorkRing';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';

interface CapsuleInputTrailingActionsProps {
  /** Whether this experience declares a history trigger in the composer row. */
  historyControl: boolean;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
  disabled: boolean;
  inputValue: string;
  onSelectHistory: (command: string) => void;
  onSend: () => void;
  /** Tooltips intercept touch on mobile — app surfaces rely on aria-label instead. */
  showTooltips?: boolean;
}

/**
 * The capsule's capability entry — the only place capability state appears.
 *
 * The resting capsule carries no capability identity (#748, revising
 * terminal-capsule.md's `active` row): every reachable capability is listed
 * here, and the ones that are relevant or active are marked. One muted control,
 * and the list opens as a popover, so the band stays a single line however many
 * capabilities exist and whatever states they are in.
 *
 * **Capsule V2 (#1347, work-awareness review 2026-10-03):** one Context
 * Disclosure serves both states. While something is working, `+` wears the
 * partial Work Ring and opens the disclosure with the sensed capabilities
 * first (SC-18/SC-35); while quiet it opens the ordinary list. The rows use
 * capability display identity and reason, never a raw id (SC-19), and a sensed
 * row opens its capability directly at Peek depth (SC-20). The old Work
 * Overview Dialog is superseded — a modal was never this surface's class
 * (SC-33).
 */
function CapsuleCapabilityMore({ disclosure, workContext }: {
  disclosure: CapsuleCapabilityDisclosure;
  workContext?: ResolvedWorkContext;
}) {
  const isWorking = workContext?.status === 'working';
  // One sensed section, two senses (#1347 SC-40): work-sensed items first —
  // "what you are running" outranks "what this device affords" — then the
  // context-sensed ones the disclosure's composer resolved. Ordering here is
  // the surface's; neither registry orders the other.
  const sensed = [
    ...sensedWorkItems(workContext, disclosure.entries),
    ...(disclosure.sensedContext ?? []),
  ];

  // One trigger, one surface (#1347 SC-18/SC-33/SC-35): the Context Disclosure
  // is anchored to `+` in both states — sensed-first while something is
  // working, the ordinary list while quiet. Sensing never opens it; the Work
  // Ring is the whole ambient representation (SC-34), and this tap is the
  // user's own deepening.
  return (
    <ContextDisclosureMenu
      sensed={sensed}
      entries={disclosure.entries}
      onSelect={disclosure.onSelect}
      onChooseSensed={disclosure.onSelectAtPeek ?? disclosure.onSelect}
      labels={{ sensed: 'Working now', all: 'All capabilities', capabilities: 'Capabilities' }}
      testIdPrefix="capsule-capability-picker"
      trigger={
        <button
          type="button"
          aria-label="More capabilities"
          data-testid="capsule-capability-more"
          className={cn(
            capsuleIconButtonClass,
            'relative inline-flex items-center justify-center bg-transparent hover:bg-transparent',
          )}
        >
          <CapsuleIconVisual>
            <Plus className="size-[length:var(--icon-md)]" />
          </CapsuleIconVisual>
          <WorkRing working={isWorking} />
        </button>
      }
    />
  );
}

/**
 * The sensed section's items: working summaries resolved to the capability's
 * display identity (#1347 SC-19).
 *
 * A summary whose capability has no disclosure entry is dropped rather than
 * rendered as its raw id — the row's copy is Nession's, and an id is not copy.
 */
function sensedWorkItems(
  workContext: ResolvedWorkContext | undefined,
  entries: CapsuleCapabilityDisclosure['entries'],
): SensedCapabilityItem[] {
  if (!workContext) {
    return [];
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return workContext.summaries.flatMap((summary) => {
    if (summary.status !== 'working') {
      return [];
    }
    const entry = byId.get(summary.capabilityId);
    return entry
      ? [
          {
            capabilityId: summary.capabilityId,
            title: entry.title,
            reason: summary.summary,
          },
        ]
      : [];
  });
}

/**
 * The leading slot — `+`, the Nession capability entry.
 *
 * It leads on both experiences, which is the order
 * `terminal-capsule.md` §Anatomy draws (`[+] [ input ... ] [send]`) and the one
 * the intent composer's resting row is built around. Nothing else earns this
 * slot: the capsule is conversational first and extensible second.
 *
 * **Capsule V2 (#1347):** Accepts workContext to show work ring on `+`.
 */
export function CapsuleInputLeading({
  capabilityDisclosure,
  workContext,
}: {
  capabilityDisclosure?: CapsuleCapabilityDisclosure;
  workContext?: ResolvedWorkContext;
}) {
  if (!capabilityDisclosure || capabilityDisclosure.entries.length === 0) {
    return null;
  }
  return (
    <div data-testid="capsule-input-leading" className={capsuleControlRowClass}>
      <CapsuleCapabilityMore disclosure={capabilityDisclosure} workContext={workContext} />
    </div>
  );
}

/**
 * Trailing actions — the experience's own history trigger, when it declares
 * one, then send. The primary action is always last.
 */
export function CapsuleInputTrailingActions({
  historyControl,
  historyOpen,
  onHistoryOpenChange,
  disabled,
  inputValue,
  onSelectHistory,
  onSend,
  showTooltips = true,
}: CapsuleInputTrailingActionsProps) {
  return (
    <div data-testid="capsule-input-actions" className={capsuleControlRowClass}>
      {historyControl ? (
        <CapsuleHistoryPopover
          open={historyOpen}
          onOpenChange={onHistoryOpenChange}
          disabled={disabled}
          onSelect={onSelectHistory}
          triggerClassName="rounded-[var(--radius-control)]"
        />
      ) : null}
      <CapsuleInputActionButtons
        inputValue={inputValue}
        disabled={disabled}
        onSend={onSend}
        showTooltips={showTooltips}
      />
    </div>
  );
}
