import { forwardRef, useCallback, useRef, useState } from 'react';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { cn } from '@/lib/utils';
import { CapsuleGhostInput } from '@/session-first/capsule/CapsuleGhostInput';
import {
  CapsuleInputLeading,
  CapsuleInputTrailingActions,
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
  /** Desktop Commands button — off by default (History + Send only). */
  showCommandsButton?: boolean;
  /** Paste/Copy — intended for mobile soft-keyboard flows. */
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

/**
 * Stable grid tree (no remount of textarea):
 * - flat, no leading:  field | actions
 * - flat, leading:     leading | field | actions
 * - stacked:           field full width; leading + actions on row 2
 */
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
    const hasLeading = Boolean(leading);

    return (
      <div
        ref={ref}
        data-testid="capsule-input-row"
        data-layout={layout}
        className={cn(
          'grid min-w-0 flex-1 gap-2',
          !isStacked &&
            !hasLeading &&
            'grid-cols-[minmax(0,1fr)_auto] grid-rows-1 items-center',
          !isStacked &&
            hasLeading &&
            'grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-1 items-center',
          isStacked &&
            'grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-y-1.5',
        )}
      >
        <div
          data-testid="capsule-input-leading-slot"
          className={cn(
            'shrink-0',
            !hasLeading && 'hidden',
            isStacked ? 'col-start-1 row-start-2' : 'col-start-1 row-start-1',
          )}
        >
          <CapsuleInputLeading leading={leading} />
        </div>

        <div
          data-testid="capsule-input-field"
          className={cn(
            'min-w-0',
            isStacked && 'col-span-3 col-start-1 row-start-1',
            !isStacked && hasLeading && 'col-start-2 row-start-1',
            !isStacked && !hasLeading && 'col-start-1 row-start-1',
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
          data-testid="capsule-input-actions-slot"
          data-flip-id="tools-actions"
          className={cn(
            'shrink-0',
            isStacked && 'col-start-3 row-start-2 justify-self-end',
            !isStacked && hasLeading && 'col-start-3 row-start-1',
            !isStacked && !hasLeading && 'col-start-2 row-start-1',
          )}
        >
          <CapsuleInputTrailingActions
            historyOpen={historyOpen}
            onHistoryOpenChange={onHistoryOpenChange}
            commandsOpen={commandsOpen}
            onCommandsOpenChange={onCommandsOpenChange}
            showCommandsButton={showCommandsButton}
            showPasteCopy={showPasteCopy}
            disabled={disabled}
            sendText={sendText}
            inputValue={inputValue}
            onSelectHistory={setInputValue}
            onSend={onSend}
            onPaste={() => pasteIntoInput(setInputValue)}
            onCopy={() => copyInputValue(inputValue)}
          />
        </div>
      </div>
    );
  },
);

/**
 * Content-driven flat ↔ stacked composer. Actions stay on the right;
 * optional leading (mode toggle) on the left.
 */
export function CapsuleInputRow({
  sendText,
  disabled = false,
  historyOpen,
  onHistoryOpenChange,
  commandsOpen,
  onCommandsOpenChange,
  showCommandsButton = false,
  showPasteCopy = false,
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
