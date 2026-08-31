import { CapsuleCommandsPopover } from '@/session-first/capsule/CapsuleCommandsPopover';
import { CapsuleHistoryPopover } from '@/session-first/capsule/CapsuleHistoryPopover';
import { CapsuleInputActionButtons } from '@/session-first/capsule/CapsuleInputActionButtons';

interface CapsuleInputToolsProps {
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

export function CapsuleInputLeftTools({
  leading,
  historyOpen,
  onHistoryOpenChange,
  commandsOpen,
  onCommandsOpenChange,
  showCommandsButton,
  disabled,
  sendText,
  onSelectHistory,
}: Pick<
  CapsuleInputToolsProps,
  | 'leading'
  | 'historyOpen'
  | 'onHistoryOpenChange'
  | 'commandsOpen'
  | 'onCommandsOpenChange'
  | 'showCommandsButton'
  | 'disabled'
  | 'sendText'
  | 'onSelectHistory'
>) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {leading}
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
    </div>
  );
}

export function CapsuleInputRightActions({
  inputValue,
  disabled,
  showPasteCopy,
  onSend,
  onPaste,
  onCopy,
}: Pick<
  CapsuleInputToolsProps,
  'inputValue' | 'disabled' | 'showPasteCopy' | 'onSend' | 'onPaste' | 'onCopy'
>) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
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
