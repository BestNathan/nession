import { CapsuleCommandsPopover } from '@/session-first/capsule/CapsuleCommandsPopover';
import { CapsuleHistoryPopover } from '@/session-first/capsule/CapsuleHistoryPopover';
import { CapsuleInputActionButtons } from '@/session-first/capsule/CapsuleInputActionButtons';
import { capsuleIconButtonClass } from '@/session-first/capsule/capsuleStyles';
import { cn } from '@/lib/utils';

interface CapsuleInputActionsProps {
  leading?: React.ReactNode;
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
}

/** Optional leading slot (e.g. mobile mode toggle) — left side only. */
export function CapsuleInputLeading({ leading }: { leading?: React.ReactNode }) {
  if (!leading) {
    return null;
  }
  return (
    <div
      data-testid="capsule-input-leading"
      className="flex h-8 shrink-0 items-center gap-1 max-lg:h-11"
    >
      {leading}
    </div>
  );
}

/**
 * Trailing actions — always History + Send; Paste/Copy and Commands opt-in.
 * Single height cluster so icons share a baseline with the field.
 */
export function CapsuleInputTrailingActions({
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
}: Omit<CapsuleInputActionsProps, 'leading'>) {
  return (
    <div
      data-testid="capsule-input-actions"
      className="flex h-8 shrink-0 items-center gap-1 max-lg:h-11"
    >
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
        triggerClassName={cn(capsuleIconButtonClass, 'rounded-lg')}
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
      />
    </div>
  );
}
