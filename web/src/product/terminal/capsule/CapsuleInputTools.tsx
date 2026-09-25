import { CapsuleHistoryPopover } from '@/product/terminal/capsule/CapsuleHistoryPopover';
import { CapsuleInputActionButtons } from '@/product/terminal/capsule/CapsuleInputActionButtons';
import {
  capsuleControlRowClass,
  capsuleIconButtonClass,
} from '@/product/terminal/capsule/capsuleStyles';
import { Plus } from 'lucide-react';
import { CapabilityDisclosureMenu } from '@/product/capability/components/CapabilityDisclosureMenu';
import type {
  CapsuleCapabilityDisclosure,
} from '@/product/terminal/capsule/types';

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
 */
function CapsuleCapabilityMore({ disclosure }: { disclosure: CapsuleCapabilityDisclosure }) {
  return (
    <CapabilityDisclosureMenu
      entries={disclosure.entries}
      onSelect={disclosure.onSelect}
      label="Capabilities"
      testIdPrefix="capsule-capability-picker"
      trigger={
        <button
          type="button"
          aria-label="More capabilities"
          data-testid="capsule-capability-more"
          className={capsuleIconButtonClass}
        >
          <Plus className="size-[length:var(--icon-md)]" />
        </button>
      }
    />
  );
}

/**
 * The leading slot — `+`, the Nession capability entry.
 *
 * It leads on both experiences, which is the order
 * `terminal-capsule.md` §Anatomy draws (`[+] [ input ... ] [send]`) and the one
 * the intent composer's resting row is built around. Nothing else earns this
 * slot: the capsule is conversational first and extensible second.
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
      <CapsuleCapabilityMore disclosure={capabilityDisclosure} />
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
          triggerClassName="rounded-lg"
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
