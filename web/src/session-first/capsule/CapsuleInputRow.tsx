import { forwardRef, useCallback, useRef, useState } from 'react';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { cn } from '@/lib/utils';
import { CapsuleGhostInput } from '@/session-first/capsule/CapsuleGhostInput';
import {
  CapsuleInputLeftTools,
  CapsuleInputRightActions,
} from '@/session-first/capsule/CapsuleInputTools';
import {
  layoutFromLineCount,
  type ComposerLayout,
} from '@/session-first/capsule/types';
import { useCapsuleLayoutFlip } from '@/session-first/capsule/useCapsuleLayoutFlip';

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
  onLayoutChange?: (layout: ComposerLayout) => void;
}

async function copyInputValue(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // clipboard unavailable
  }
}

function pasteIntoInput(
  setInputValue: React.Dispatch<React.SetStateAction<string>>,
): void {
  if (!navigator.clipboard?.readText) {
    return;
  }
  navigator.clipboard
    .readText()
    .then((text) => {
      if (text) {
        setInputValue((prev) => prev + text);
      }
    })
    .catch(() => undefined);
}

interface CapsuleComposerGridProps {
  layout: ComposerLayout;
  inputValue: string;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  disabled: boolean;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
  commandsOpen: boolean;
  onCommandsOpenChange: (open: boolean) => void;
  showCommandsButton: boolean;
  showPasteCopy: boolean;
  leading?: React.ReactNode;
  sendText: (text: string) => void;
  onSend: () => void;
  onLineCountChange: (lineCount: number) => void;
}

const CapsuleComposerGrid = forwardRef<HTMLDivElement, CapsuleComposerGridProps>(
  function CapsuleComposerGrid(
    {
      layout,
      inputValue,
      setInputValue,
      disabled,
      historyOpen,
      onHistoryOpenChange,
      commandsOpen,
      onCommandsOpenChange,
      showCommandsButton,
      showPasteCopy,
      leading,
      sendText,
      onSend,
      onLineCountChange,
    },
    ref,
  ) {
  const isStacked = layout === 'stacked';

  return (
    <div
      ref={ref}
      data-testid="capsule-input-row"
      data-layout={layout}
      className={cn(
        'grid min-w-0 flex-1 gap-1',
        !isStacked && 'grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-1 items-end',
        isStacked &&
          'grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-end',
      )}
    >
      <div
        data-testid="capsule-input-left"
        data-flip-id="tools-left"
        className={cn(
          'shrink-0',
          isStacked ? 'col-start-1 row-start-2' : 'col-start-1 row-start-1',
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
          'min-w-0',
          isStacked ? 'col-span-3 col-start-1 row-start-1' : 'col-start-2 row-start-1',
        )}
      >
        <CapsuleGhostInput
          value={inputValue}
          onChange={setInputValue}
          disabled={disabled}
          onEnter={onSend}
          onLineCountChange={onLineCountChange}
        />
      </div>

      <div
        data-testid="capsule-input-right"
        data-flip-id="tools-right"
        className={cn(
          'shrink-0',
          isStacked
            ? 'col-start-3 row-start-2 justify-self-end'
            : 'col-start-3 row-start-1',
        )}
      >
        <CapsuleInputRightActions
          inputValue={inputValue}
          disabled={disabled}
          showPasteCopy={showPasteCopy}
          onSend={onSend}
          onPaste={() => pasteIntoInput(setInputValue)}
          onCopy={() => copyInputValue(inputValue)}
        />
      </div>

      {isStacked ? (
        <div
          data-testid="capsule-input-toolbar"
          aria-hidden
          className="pointer-events-none col-span-3 col-start-1 row-start-2"
        />
      ) : null}
    </div>
  );
  },
);

/**
 * CSS-grid composer: tools flank the input (`flat`) or sit on a bottom toolbar (`stacked`).
 * Stable DOM tree — CapsuleGhostInput never reparents; FLIP animates tool positions.
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
  onLayoutChange,
}: CapsuleInputRowProps) {
  const [inputValue, setInputValue] = useState('');
  const [layout, setLayout] = useState<ComposerLayout>('flat');
  const rootRef = useRef<HTMLDivElement>(null);
  const { captureBeforeLayoutChange } = useCapsuleLayoutFlip(layout, rootRef);
  const { addEntry } = useCommandHistory();

  const handleLineCountChange = useCallback(
    (lineCount: number) => {
      const next = layoutFromLineCount(lineCount);
      if (next !== layout) {
        captureBeforeLayoutChange();
        setLayout(next);
        onLayoutChange?.(next);
      }
    },
    [layout, captureBeforeLayoutChange, onLayoutChange],
  );

  const doSend = () => {
    const text = inputValue.trim();
    if (!text) {
      return;
    }
    sendText(`${text}\r`);
    addEntry(text);
    setInputValue('');
    captureBeforeLayoutChange();
    setLayout('flat');
    onLayoutChange?.('flat');
    onHistoryOpenChange(false);
    onCommandsOpenChange(false);
  };

  return (
    <CapsuleComposerGrid
      ref={rootRef}
      layout={layout}
      inputValue={inputValue}
      setInputValue={setInputValue}
      disabled={disabled}
      historyOpen={historyOpen}
      onHistoryOpenChange={onHistoryOpenChange}
      commandsOpen={commandsOpen}
      onCommandsOpenChange={onCommandsOpenChange}
      showCommandsButton={showCommandsButton}
      showPasteCopy={showPasteCopy}
      leading={leading}
      sendText={sendText}
      onSend={doSend}
      onLineCountChange={handleLineCountChange}
    />
  );
}
