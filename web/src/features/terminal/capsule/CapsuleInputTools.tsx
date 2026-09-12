import { CapsuleCommandsPopover } from '@/features/terminal/capsule/CapsuleCommandsPopover';
import { CapsuleHistoryPopover } from '@/features/terminal/capsule/CapsuleHistoryPopover';
import { CapsuleInputActionButtons } from '@/features/terminal/capsule/CapsuleInputActionButtons';
import {
  capsuleControlRowClass,
  capsuleIconButtonClass,
  capsuleSecondaryIconButtonClass,
} from '@/features/terminal/capsule/capsuleStyles';
import { cn } from '@/lib/utils';
import { CapsuleCapability } from '@/features/terminal/capsule/components/CapsuleCapability';
import type { CapsuleCapabilityPresence } from '@/features/terminal/capsule/types';

interface CapsuleInputActionsProps {
  leading?: React.ReactNode;
  /** Capability that earned capsule presence, if any. At most one. */
  capability?: CapsuleCapabilityPresence;
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
  compactSecondary?: boolean;
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
 * App uses compact secondary icons so the field keeps horizontal space.
 */
export function CapsuleInputTrailingActions({
  capability,
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
  compactSecondary = false,
}: Omit<CapsuleInputActionsProps, 'leading'>) {
  const secondaryIconClass = compactSecondary
    ? capsuleSecondaryIconButtonClass
    : capsuleIconButtonClass;

  return (
    <div data-testid="capsule-input-actions" className={capsuleControlRowClass}>
      {capability ? <CapsuleCapability capability={capability} /> : null}
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
        triggerClassName={cn(secondaryIconClass, 'rounded-lg')}
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
        secondaryIconClass={secondaryIconClass}
        showTooltips={!compactSecondary}
      />
    </div>
  );
}
