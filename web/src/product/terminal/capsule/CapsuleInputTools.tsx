import { CapsuleHistoryPopover } from '@/product/terminal/capsule/CapsuleHistoryPopover';
import { CapsuleInputActionButtons } from '@/product/terminal/capsule/CapsuleInputActionButtons';
import {
  capsuleControlRowClass,
  capsuleIconButtonClass,
} from '@/product/terminal/capsule/capsuleStyles';
import { CapsuleIconVisual } from '@/product/terminal/capsule/CapsuleIconVisual';
import { Plus } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type {
  CapsuleCapabilityDisclosure,
} from '@/product/terminal/capsule/types';
import { useCapsuleContext } from '@/product/terminal/capsule/state/useCapsuleContext';
import { CONTEXT_CAPSULE_ID } from '@/product/terminal/capsule/contextCapsuleId';

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
 * **Capsule V2 (#1347, 2026-10-04 review):** this button is a plain toggle onto
 * the upper Context Capsule, which is a sibling surface above this one rather
 * than a menu anchored to `+` (SC-41). It carries `aria-expanded` and
 * `aria-controls`, and nothing else about it changes.
 *
 * **No ambient work marker (#2663, 2026-11-03 owner decision).** The resting
 * `+` is identical in every lifecycle state: the static 270° `WorkRing` (and
 * the `working` sense behind it) was rejected as reading like a frozen
 * spinner. Contextual identity and status live only in the disclosed Context
 * Capsule, which the user opens explicitly.
 */
function CapsuleCapabilityMore() {
  const { contextOpen, setContextOpen, contextTriggerRef } = useCapsuleContext();

  return (
    <button
      ref={contextTriggerRef}
      type="button"
      aria-label="More capabilities"
      aria-expanded={contextOpen}
      aria-controls={CONTEXT_CAPSULE_ID}
      data-testid="capsule-capability-more"
      onClick={() => setContextOpen(!contextOpen)}
      className={cn(
        capsuleIconButtonClass,
        'inline-flex items-center justify-center bg-transparent hover:bg-transparent',
      )}
    >
      <CapsuleIconVisual>
        <Plus className="size-[length:var(--nession-icon-md)]" />
      </CapsuleIconVisual>
    </button>
  );
}

/**
 * The leading slot — `+`, the Nession capability entry.
 *
 * It leads on both experiences, which is the order
 * `terminal-capsule.md` §Anatomy draws (`[+] [ input ... ] [send]`) and the one
 * the intent composer's resting row is built around. Nothing else earns this
 * slot: the capsule is conversational first and extensible second.
 *
 * **Capsule V2 (#1347):** the leading slot is the plain `+` in every state;
 * work context is not drawn here (#2663).
 */
export function CapsuleInputLeading({
  capabilityDisclosure,
}: {
  capabilityDisclosure?: CapsuleCapabilityDisclosure;
}) {
  if (!capabilityDisclosure || capabilityDisclosure.entries.length === 0) {
    return null;
  }
  return (
    <div data-testid="capsule-input-leading" className={capsuleControlRowClass}>
      <CapsuleCapabilityMore />
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
          triggerClassName="rounded-[var(--nession-radius-control)]"
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
