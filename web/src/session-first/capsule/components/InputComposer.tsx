import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { CapsuleGhostInput } from '@/session-first/capsule/CapsuleGhostInput';
import {
  CapsuleInputLeading,
  CapsuleInputTrailingActions,
} from '@/session-first/capsule/CapsuleInputTools';
import {
  capsuleComposerGridGapClass,
  capsuleComposerRowGapYClass,
} from '@/session-first/capsule/capsuleStyles';
import { useCapsuleContext } from '@/session-first/capsule/state/useCapsuleContext';

interface InputComposerProps {
  leading?: React.ReactNode;
}

/**
 * Single DOM tree so flat ↔ stacked transitions keep textarea focus.
 * Web flat: inline field + tools. App / stacked: full-width field, toolbar below.
 */
export const InputComposer = forwardRef<HTMLDivElement, InputComposerProps>(
  function InputComposer({ leading }, ref) {
    const ctx = useCapsuleContext();
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
      experience,
      experienceConfig,
    } = ctx;

    const isStacked = composerLayout === 'stacked';
    const isApp = experience === 'app';
    const fieldFirstLayout = isApp || isStacked;
    const hasLeading = Boolean(leading);
    const controls = experienceConfig.inputControls;

    return (
      <div
        ref={ref}
        data-testid="capsule-input-row"
        data-layout={composerLayout}
        data-field-first={isApp && !isStacked ? 'app' : undefined}
        className={cn(
          'grid min-w-0 flex-1',
          fieldFirstLayout
            ? cn('grid-rows-[auto_auto]', capsuleComposerRowGapYClass)
            : cn('grid-rows-1 items-center', capsuleComposerGridGapClass, 'grid-cols-[minmax(0,1fr)_auto]'),
        )}
      >
        <div
          data-testid="capsule-input-field"
          data-input-width={fieldFirstLayout ? 'full' : 'column'}
          className={cn(
            'min-w-0 w-full',
            !fieldFirstLayout && 'col-start-1 row-start-1',
          )}
        >
          <CapsuleGhostInput
            value={inputValue}
            onChange={setInputValue}
            disabled={disabled}
            onEnter={send}
          />
        </div>

        {fieldFirstLayout ? (
          <div
            data-testid="capsule-input-toolbar-row"
            className="flex min-w-0 items-center justify-between gap-[length:var(--composer-control-gap)]"
          >
            <div
              data-testid="capsule-input-leading-slot"
              className={cn('min-w-0 shrink-0', !hasLeading && 'hidden')}
            >
              <CapsuleInputLeading leading={leading} />
            </div>
            <div
              data-testid="capsule-input-actions-slot"
              data-flip-id="tools-actions"
              className="ml-auto shrink-0"
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
                compactSecondary={isApp}
              />
            </div>
          </div>
        ) : (
          <div
            data-testid="capsule-input-actions-slot"
            data-flip-id="tools-actions"
            className="col-start-2 row-start-1 shrink-0 justify-self-end"
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
              compactSecondary={false}
            />
          </div>
        )}
      </div>
    );
  },
);
