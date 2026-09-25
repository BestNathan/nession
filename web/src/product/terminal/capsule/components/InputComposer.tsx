import { forwardRef, type RefObject } from 'react';
import { cn } from '@/shared/lib/utils';
import type {
  CapsuleCapabilityDisclosure,
} from '@/product/terminal/capsule/types';
import { CapsuleGhostInput } from '@/product/terminal/capsule/CapsuleGhostInput';
import {
  CapsuleInputLeading,
  CapsuleInputTrailingActions,
} from '@/product/terminal/capsule/CapsuleInputTools';
import {
  capsuleComposerGridGapClass,
  capsuleComposerRowGapYClass,
} from '@/product/terminal/capsule/capsuleStyles';
import { useCapsuleContext } from '@/product/terminal/capsule/state/useCapsuleContext';

interface InputComposerProps {
  /** Capabilities that earned no chip, reachable through the leading entry. */
  capabilityDisclosure?: CapsuleCapabilityDisclosure;
  /**
   * The field's focus events, passed straight through to it.
   *
   * The composer is a layout; what focus *means* is the capsule's, so these two
   * travel from the capsule to the field without a decision in between (see
   * `CapsuleGhostInput`).
   */
  onFieldFocus?: () => void;
  fieldRef?: RefObject<HTMLTextAreaElement>;
}

/**
 * Single DOM tree so flat ↔ stacked transitions keep textarea focus.
 *
 * Flat (the resting row, both experiences): `+`, field, send — one band, at
 * `control.md` height, which is why the App row is 44px and not a two-row
 * stack. Stacked (the input wrapped): the field takes its own full-width row
 * and the tools sit beneath it, `+` still leftmost and send still rightmost.
 */
export const InputComposer = forwardRef<HTMLDivElement, InputComposerProps>(
  function InputComposer({ capabilityDisclosure, onFieldFocus, fieldRef }, ref) {
    const ctx = useCapsuleContext();
    const {
      inputValue,
      setInputValue,
      composerLayout,
      historyOpen,
      setHistoryOpen,
      disabled,
      send,
      experience,
      experienceConfig,
    } = ctx;

    const isApp = experience === 'app';
    const fieldFirstLayout = composerLayout === 'stacked';
    const hasLeading = Boolean(capabilityDisclosure?.entries.length);
    const { historyControl, intentPlaceholder } = experienceConfig;

    const trailingActions = (
      <CapsuleInputTrailingActions
        historyControl={historyControl}
        historyOpen={historyOpen}
        onHistoryOpenChange={setHistoryOpen}
        disabled={disabled}
        inputValue={inputValue}
        onSelectHistory={setInputValue}
        onSend={send}
        showTooltips={!isApp}
      />
    );

    return (
      <div
        ref={ref}
        data-testid="capsule-input-row"
        data-layout={composerLayout}
        className={cn(
          'grid min-w-0 flex-1',
          fieldFirstLayout
            ? cn('grid-rows-[auto_auto]', capsuleComposerRowGapYClass)
            : cn(
                'grid-rows-1 items-center',
                capsuleComposerGridGapClass,
                'grid-cols-[auto_minmax(0,1fr)_auto]',
              ),
        )}
      >
        <div
          data-testid="capsule-input-field"
          data-input-width={fieldFirstLayout ? 'full' : 'column'}
          className={cn(
            'min-w-0 w-full overflow-hidden',
            !fieldFirstLayout && 'col-start-2 row-start-1',
          )}
        >
          <CapsuleGhostInput
            value={inputValue}
            onChange={setInputValue}
            disabled={disabled}
            placeholder={intentPlaceholder}
            onEnter={send}
            onFocus={onFieldFocus}
            fieldRef={fieldRef}
          />
        </div>

        {fieldFirstLayout ? (
          <div
            data-testid="capsule-input-toolbar-row"
            className="flex min-w-0 items-center justify-between gap-[length:var(--terminal-capsule-control-gap)]"
          >
            <div
              data-testid="capsule-input-leading-slot"
              data-flip-id="tools-leading"
              className={cn('relative z-[1] min-w-0 shrink-0', !hasLeading && 'hidden')}
            >
              <CapsuleInputLeading capabilityDisclosure={capabilityDisclosure} />
            </div>
            <div
              data-testid="capsule-input-actions-slot"
              data-flip-id="tools-actions"
              className="relative z-[1] ml-auto shrink-0"
            >
              {trailingActions}
            </div>
          </div>
        ) : (
          <>
            <div
              data-testid="capsule-input-leading-slot"
              data-flip-id="tools-leading"
              className={cn(
                'relative z-[1] col-start-1 row-start-1 shrink-0',
                !hasLeading && 'hidden',
              )}
            >
              <CapsuleInputLeading capabilityDisclosure={capabilityDisclosure} />
            </div>
            <div
              data-testid="capsule-input-actions-slot"
              data-flip-id="tools-actions"
              className="col-start-3 row-start-1 relative z-[1] shrink-0 justify-self-end"
            >
              {trailingActions}
            </div>
          </>
        )}
      </div>
    );
  },
);
