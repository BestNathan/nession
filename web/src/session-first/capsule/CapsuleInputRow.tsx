import { useEffect, useState } from 'react';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { CapsuleCommandsPopover } from '@/session-first/capsule/CapsuleCommandsPopover';
import { CapsuleGhostInput } from '@/session-first/capsule/CapsuleGhostInput';
import { CapsuleHistoryPopover } from '@/session-first/capsule/CapsuleHistoryPopover';
import { CapsuleInputActionButtons } from '@/session-first/capsule/CapsuleInputActionButtons';
import type { DockHeight } from '@/session-first/capsule/types';

interface CapsuleInputRowProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
  commandsOpen: boolean;
  onCommandsOpenChange: (open: boolean) => void;
  showCommandsButton?: boolean;
  showPasteCopy?: boolean;
  leading?: React.ReactNode;
  onHeightChange?: (height: DockHeight) => void;
}

export function CapsuleInputRow({
  sendText,
  disabled = false,
  historyOpen,
  onHistoryOpenChange,
  commandsOpen,
  onCommandsOpenChange,
  showCommandsButton = true,
  showPasteCopy = true,
  leading,
  onHeightChange,
}: CapsuleInputRowProps) {
  const [inputValue, setInputValue] = useState('');
  const { addEntry } = useCommandHistory();

  useEffect(() => {
    const isMulti = inputValue.includes('\n') || inputValue.split('\n').length > 1;
    onHeightChange?.(isMulti ? 'multi' : 'single');
  }, [inputValue, onHeightChange]);

  const doSend = () => {
    const text = inputValue.trim();
    if (!text) {
      return;
    }
    sendText(`${text}\r`);
    addEntry(text);
    setInputValue('');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inputValue);
    } catch {
      // clipboard unavailable
    }
  };

  const handlePaste = () => {
    if (navigator.clipboard?.readText) {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) {
            setInputValue((prev) => prev + text);
          }
        })
        .catch(() => undefined);
    }
  };

  return (
    <div
      data-testid="capsule-input-row"
      className="flex min-w-0 flex-1 flex-col gap-1"
    >
      <CapsuleGhostInput
        value={inputValue}
        onChange={setInputValue}
        disabled={disabled}
        onEnter={doSend}
        className="w-full"
      />
      <div
        data-testid="capsule-input-toolbar"
        className="flex items-center justify-between gap-1"
      >
        <div className="flex items-center gap-0.5">
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
            onSelect={setInputValue}
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
        <div className="flex items-center gap-0.5">
          <CapsuleInputActionButtons
            inputValue={inputValue}
            disabled={disabled}
            showPasteCopy={showPasteCopy}
            onSend={doSend}
            onPaste={handlePaste}
            onCopy={handleCopy}
          />
        </div>
      </div>
    </div>
  );
}
