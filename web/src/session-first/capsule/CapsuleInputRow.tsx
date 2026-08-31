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
 * Fixed row layout: left tools | growing textarea | right actions.
 * Tools stay bottom-aligned (`items-end`); only textarea height animates —
 * no layout teleport between single/multi.
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
      className={cn('flex min-w-0 flex-1 items-end gap-1')}
    >
      <div data-testid="capsule-input-left" className="shrink-0">
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

      <div data-testid="capsule-input-field" className="min-w-0 flex-1">
        <CapsuleGhostInput
          value={inputValue}
          onChange={setInputValue}
          disabled={disabled}
          onEnter={doSend}
          onLineCountChange={handleLineCountChange}
        />
      </div>

      <div data-testid="capsule-input-right" className="shrink-0">
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
