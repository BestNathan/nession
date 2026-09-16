import { CapsuleCommandsPopover } from '@/features/terminal/capsule/CapsuleCommandsPopover';
import { CapsuleHistoryPopover } from '@/features/terminal/capsule/CapsuleHistoryPopover';
import { CapsuleInputActionButtons } from '@/features/terminal/capsule/CapsuleInputActionButtons';
import {
  capsuleControlRowClass,
  capsuleIconButtonClass,
} from '@/features/terminal/capsule/capsuleStyles';
import { Plus } from 'lucide-react';
import { CapabilityDisclosureMenu } from '@/features/capabilities/components/CapabilityDisclosureMenu';
import type {
  CapsuleCapabilityDisclosure,
} from '@/features/terminal/capsule/types';

interface CapsuleInputActionsProps {
  leading?: React.ReactNode;
  /** Capabilities that earned no chip, reachable through the disclosure entry. */
  capabilityDisclosure?: CapsuleCapabilityDisclosure;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
  commandsOpen: boolean;
  onCommandsOpenChange: (open: boolean) => void;
  showCommandsButton: boolean;
  showPasteCopy: boolean;
  disabled: boolean;
  sendText: (text: string) => void;
  inputValue: string;
  onSelectHistory: (command: string) => void;
  onSend: () => void;
  onPaste: () => void;
  onCopy: () => void;
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

/** Optional leading slot (e.g. mobile mode toggle) — left side only. */
export function CapsuleInputLeading({ leading }: { leading?: React.ReactNode }) {
  if (!leading) {
    return null;
  }
  return (
    <div data-testid="capsule-input-leading" className={capsuleControlRowClass}>
      {leading}
    </div>
  );
}

/**
 * Trailing actions — always History + Send; Paste/Copy and Commands opt-in.
 */
export function CapsuleInputTrailingActions({
  capabilityDisclosure,
  historyOpen,
  onHistoryOpenChange,
  commandsOpen,
  onCommandsOpenChange,
  showCommandsButton,
  showPasteCopy,
  disabled,
  sendText,
  inputValue,
  onSelectHistory,
  onSend,
  onPaste,
  onCopy,
  showTooltips = true,
}: Omit<CapsuleInputActionsProps, 'leading'>) {
  return (
    <div data-testid="capsule-input-actions" className={capsuleControlRowClass}>
      {capabilityDisclosure && capabilityDisclosure.entries.length > 0 ? (
        <CapsuleCapabilityMore disclosure={capabilityDisclosure} />
      ) : null}
      <CapsuleHistoryPopover
        open={historyOpen}
        onOpenChange={(open) => {
          onHistoryOpenChange(open);
          if (open) {
            onCommandsOpenChange(false);
          }
        }}
        disabled={disabled}
        onSelect={onSelectHistory}
        triggerClassName="rounded-lg"
      />
      {showCommandsButton ? (
        <CapsuleCommandsPopover
          open={commandsOpen}
          onOpenChange={(open) => {
            onCommandsOpenChange(open);
            if (open) {
              onHistoryOpenChange(false);
            }
          }}
          sendText={sendText}
          disabled={disabled}
          showPhysKeys={false}
        />
      ) : null}
      <CapsuleInputActionButtons
        inputValue={inputValue}
        disabled={disabled}
        showPasteCopy={showPasteCopy}
        onSend={onSend}
        onPaste={onPaste}
        onCopy={onCopy}
        showTooltips={showTooltips}
      />
    </div>
  );
}
