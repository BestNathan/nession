import { useCallback, useState } from 'react';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { cn } from '@/lib/utils';
import { CapsuleGhostInput } from '@/session-first/capsule/CapsuleGhostInput';
import {
  CapsuleInputLeftTools,
  CapsuleInputRightActions,
} from '@/session-first/capsule/CapsuleInputTools';
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

/**
 * Stable 3-slot CSS grid (left | input | right) so expand/collapse only
 * moves grid areas — the textarea node is never remounted (focus preserved).
 */
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
  const [isMulti, setIsMulti] = useState(false);
  const { addEntry } = useCommandHistory();

  const handleLineCountChange = useCallback(
    (lineCount: number) => {
      const nextMulti = lineCount >= 2;
      setIsMulti(nextMulti);
      onHeightChange?.(nextMulti ? 'multi' : 'single');
    },
    [onHeightChange],
  );

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
      data-expanded={isMulti ? 'true' : 'false'}
      className={cn(
        'grid min-w-0 flex-1 gap-x-1 gap-y-1',
        'transition-[gap] duration-300 ease-[var(--sf-ease)]',
        isMulti
          ? 'grid-cols-[auto_1fr_auto] grid-rows-[auto_auto]'
          : 'grid-cols-[auto_1fr_auto] grid-rows-1 items-center',
      )}
    >
      <div
        data-testid="capsule-input-left"
        className={cn(
          'transition-[translate] duration-300 ease-[var(--sf-ease)]',
          isMulti ? 'col-start-1 row-start-2' : 'col-start-1 row-start-1',
        )}
      >
        <CapsuleInputLeftTools
          leading={leading}
          historyOpen={historyOpen}
          onHistoryOpenChange={onHistoryOpenChange}
          commandsOpen={commandsOpen}
          onCommandsOpenChange={onCommandsOpenChange}
          showCommandsButton={showCommandsButton}
          disabled={disabled}
          sendText={sendText}
          onSelectHistory={setInputValue}
        />
      </div>

      <div
        data-testid="capsule-input-field"
        className={cn(
          'min-w-0 transition-[grid-column] duration-300 ease-[var(--sf-ease)]',
          isMulti ? 'col-span-3 row-start-1' : 'col-start-2 row-start-1',
        )}
      >
        <CapsuleGhostInput
          value={inputValue}
          onChange={setInputValue}
          disabled={disabled}
          onEnter={doSend}
          onLineCountChange={handleLineCountChange}
          expanded={isMulti}
          className="w-full"
        />
      </div>

      <div
        data-testid="capsule-input-right"
        className={cn(
          'justify-self-end transition-[translate] duration-300 ease-[var(--sf-ease)]',
          isMulti ? 'col-start-3 row-start-2' : 'col-start-3 row-start-1',
        )}
      >
        <CapsuleInputRightActions
          inputValue={inputValue}
          disabled={disabled}
          showPasteCopy={showPasteCopy}
          onSend={doSend}
          onPaste={handlePaste}
          onCopy={handleCopy}
        />
      </div>
    </div>
  );
}
