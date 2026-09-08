import { PRESETS } from '@/features/commands/quickCommands';
import { Separator } from '@/components/ui/separator';
import {
  capsuleCaptionTextClass,
  capsuleCommandsPanelCommandsRegionClass,
  capsuleCommandsPanelKeysRegionClass,
  capsuleCommandsPanelListClass,
  capsulePopoverBodyClass,
  capsulePopoverItemClass,
} from '@/features/terminal/capsule/capsuleStyles';
import { cn } from '@/lib/utils';
import { CapsuleAddCommandButton, CapsuleDeleteButton } from '@/features/terminal/capsule/CapsuleAddCommandDialog';
import { CapsuleChainBar } from '@/features/terminal/capsule/CapsuleChainBar';
import { PhysKeyRow } from '@/features/terminal/capsule/PhysKeyRow';
import type { useCapsuleCommands } from '@/features/terminal/capsule/useCapsuleCommands';

export interface CapsuleCommandsPanelBodyProps {
  disabled: boolean;
  layout?: 'popover' | 'overlay';
  showPhysKeys?: boolean;
  onAddCommandClick: () => void;
  listClassName?: string;
  allCommands: ReturnType<typeof useCapsuleCommands>['allCommands'];
  presetIds: ReturnType<typeof useCapsuleCommands>['presetIds'];
  chainBuffer: string[];
  isChaining: boolean;
  handleRun: ReturnType<typeof useCapsuleCommands>['handleRun'];
  handlePhysKey: ReturnType<typeof useCapsuleCommands>['handlePhysKey'];
  handleChainStart: ReturnType<typeof useCapsuleCommands>['handleChainStart'];
  handleChainAdd: ReturnType<typeof useCapsuleCommands>['handleChainAdd'];
  cancelChain: ReturnType<typeof useCapsuleCommands>['cancelChain'];
  sendChain: ReturnType<typeof useCapsuleCommands>['sendChain'];
  deleteCommand: ReturnType<typeof useCapsuleCommands>['deleteCommand'];
}

function CommandsList({
  disabled,
  listClassName,
  allCommands,
  presetIds,
  handleRun,
  deleteCommand,
}: Pick<
  CapsuleCommandsPanelBodyProps,
  'disabled' | 'listClassName' | 'allCommands' | 'presetIds' | 'handleRun' | 'deleteCommand'
>) {
  return (
    <div className={listClassName}>
      {allCommands.map((command, index) => {
        const isPreset = presetIds.has(command.id);
        const showSeparator = index === PRESETS.length && index > 0;
        return (
          <div key={command.id}>
            {showSeparator ? <Separator /> : null}
            <button
              type="button"
              className={capsulePopoverItemClass}
              disabled={disabled}
              onClick={() => handleRun(command)}
            >
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              {isPreset ? (
                <span className={cn(capsuleCaptionTextClass, 'shrink-0 text-muted-foreground/60')}>
                  built-in
                </span>
              ) : (
                <CapsuleDeleteButton onClick={() => { void deleteCommand(command.id); }} />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function CapsuleCommandsPanelBody({
  disabled,
  layout = 'popover',
  showPhysKeys = true,
  onAddCommandClick,
  listClassName = capsuleCommandsPanelListClass,
  allCommands,
  presetIds,
  chainBuffer,
  isChaining,
  handleRun,
  handlePhysKey,
  handleChainStart,
  handleChainAdd,
  cancelChain,
  sendChain,
  deleteCommand,
}: CapsuleCommandsPanelBodyProps) {
  const chainBar = isChaining ? (
    <CapsuleChainBar buffer={chainBuffer} onCancel={cancelChain} onSend={sendChain} />
  ) : null;

  if (layout === 'overlay') {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {chainBar}
        <div className={capsuleCommandsPanelKeysRegionClass}>
          <PhysKeyRow
            onKey={handlePhysKey}
            disabled={disabled}
            chainBuffer={chainBuffer}
            isChaining={isChaining}
            onChainStart={handleChainStart}
            onChainAdd={handleChainAdd}
          />
        </div>
        <div className={capsuleCommandsPanelCommandsRegionClass}>
          <CommandsList
            disabled={disabled}
            listClassName={listClassName}
            allCommands={allCommands}
            presetIds={presetIds}
            handleRun={handleRun}
            deleteCommand={deleteCommand}
          />
          <div className="shrink-0 border-t border-border/60">
            <CapsuleAddCommandButton disabled={disabled} onClick={onAddCommandClick} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={capsulePopoverBodyClass}>
      {chainBar}
      {showPhysKeys ? (
        <PhysKeyRow
          onKey={handlePhysKey}
          disabled={disabled}
          chainBuffer={chainBuffer}
          isChaining={isChaining}
          onChainStart={handleChainStart}
          onChainAdd={handleChainAdd}
        />
      ) : null}
      <CommandsList
        disabled={disabled}
        listClassName={listClassName}
        allCommands={allCommands}
        presetIds={presetIds}
        handleRun={handleRun}
        deleteCommand={deleteCommand}
      />
      <div className="border-t border-border/60">
        <CapsuleAddCommandButton disabled={disabled} onClick={onAddCommandClick} />
      </div>
    </div>
  );
}
