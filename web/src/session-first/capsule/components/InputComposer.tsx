import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { CapsuleGhostInput } from '@/session-first/capsule/CapsuleGhostInput';
import {
  CapsuleInputLeading,
  CapsuleInputTrailingActions,
} from '@/session-first/capsule/CapsuleInputTools';
import { useCapsuleContext } from '@/session-first/capsule/state/useCapsuleContext';

interface InputComposerProps {
  leading?: React.ReactNode;
}

/**
 * Content-driven flat ↔ stacked composer. Stacked field spans full shell width.
 */
export const InputComposer = forwardRef<HTMLDivElement, InputComposerProps>(
  function InputComposer({ leading }, ref) {
    const {
      inputValue,
      setInputValue,
      composerLayout,
      historyOpen,
      commandsOpen,
      setHistoryOpen,
      setCommandsOpen,
      disabled,
      send,
      pasteIntoInput,
      copyInput,
      sendText,
      experienceConfig,
    } = useCapsuleContext();

    const isStacked = composerLayout === 'stacked';
    const hasLeading = Boolean(leading);
    const controls = experienceConfig.inputControls;
    const cols = hasLeading
      ? 'grid-cols-[auto_minmax(0,1fr)_auto]'
      : 'grid-cols-[minmax(0,1fr)_auto]';

    return (
      <div
        ref={ref}
        data-testid="capsule-input-row"
        data-layout={composerLayout}
        className={cn(
          'grid min-w-0 flex-1 items-center gap-2',
          cols,
          isStacked ? 'grid-rows-[auto_auto] gap-y-1.5' : 'grid-rows-1',
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
          data-input-width={isStacked ? 'full' : 'column'}
          className={cn(
            'min-w-0',
            isStacked && 'col-span-full row-start-1',
            !isStacked &&
              (hasLeading ? 'col-start-2 row-start-1' : 'col-start-1 row-start-1'),
          )}
        >
          <CapsuleGhostInput
            value={inputValue}
            onChange={setInputValue}
            disabled={disabled}
            onEnter={send}
          />
        </div>

        <div
          data-testid="capsule-input-actions-slot"
          data-flip-id="tools-actions"
          className={cn(
            'shrink-0',
            isStacked &&
              hasLeading &&
              'col-start-3 row-start-2 justify-self-end',
            isStacked &&
              !hasLeading &&
              'col-span-full row-start-2 justify-self-end',
            !isStacked &&
              hasLeading &&
              'col-start-3 row-start-1 justify-self-end',
            !isStacked && !hasLeading && 'col-start-2 row-start-1 justify-self-end',
          )}
        >
          <CapsuleInputTrailingActions
            historyOpen={historyOpen}
            onHistoryOpenChange={setHistoryOpen}
            commandsOpen={commandsOpen}
            onCommandsOpenChange={setCommandsOpen}
            showCommandsButton={controls.commands}
            showPasteCopy={controls.paste || controls.copy}
            disabled={disabled}
            sendText={sendText}
            inputValue={inputValue}
            onSelectHistory={setInputValue}
            onSend={send}
            onPaste={pasteIntoInput}
            onCopy={() => {
              void copyInput();
            }}
          />
        </div>
      </div>
    );
  },
);
