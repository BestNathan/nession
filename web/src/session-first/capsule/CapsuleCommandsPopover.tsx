import { useState } from 'react';
import { Terminal } from 'lucide-react';
import { PRESETS } from '@/components/quickCommands';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { CapsuleAddCommandButton, CapsuleAddCommandDialog, CapsuleDeleteButton } from '@/session-first/capsule/CapsuleAddCommandDialog';
import { CapsuleChainBar } from '@/session-first/capsule/CapsuleChainBar';
import { PhysKeyRow } from '@/session-first/capsule/PhysKeyRow';
import { useCapsuleCommands } from '@/session-first/capsule/useCapsuleCommands';

interface CapsuleCommandsPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sendText: (text: string) => void;
  disabled?: boolean;
  showPhysKeys: boolean;
  trigger?: React.ReactElement;
}

export function CapsuleCommandsPopover({
  open,
  onOpenChange,
  sendText,
  disabled = false,
  showPhysKeys,
  trigger,
}: CapsuleCommandsPopoverProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const {
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
    addCommand,
    deleteCommand,
  } = useCapsuleCommands(sendText);

  const defaultTrigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      data-testid="capsule-commands-trigger"
      className="max-lg:min-h-11 max-lg:min-w-11"
      aria-label="Quick commands"
    >
      <Terminal className="size-4" />
    </Button>
  );

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          nativeButton={false}
          disabled={disabled}
          render={trigger ?? defaultTrigger}
        />
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          className="z-[100] max-h-[45vh] w-80 overflow-hidden border-border bg-popover p-0 text-popover-foreground shadow-md"
        >
          <PopoverHeader className="border-b border-border/60 p-2">
            <PopoverTitle>Commands</PopoverTitle>
          </PopoverHeader>
          <div className="flex max-h-[42vh] flex-col overflow-hidden">
            {isChaining ? (
              <CapsuleChainBar buffer={chainBuffer} onCancel={cancelChain} onSend={sendChain} />
            ) : null}
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
            <div className="min-h-0 flex-1 overflow-y-auto">
              {allCommands.map((command, index) => {
                const isPreset = presetIds.has(command.id);
                const showSeparator = index === PRESETS.length && index > 0;
                return (
                  <div key={command.id}>
                    {showSeparator ? <Separator /> : null}
                    <button
                      type="button"
                      className="flex h-8 w-full items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-accent/40 disabled:opacity-50"
                      disabled={disabled}
                      onClick={() => handleRun(command)}
                    >
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {isPreset ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground/60">built-in</span>
                      ) : (
                        <CapsuleDeleteButton onClick={() => { void deleteCommand(command.id); }} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-border/60">
              <CapsuleAddCommandDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                disabled={disabled}
                onAddPlain={(label, command) => addCommand(label, command, false)}
                onAddCombo={(label, seq) => addCommand(label, seq, true)}
              />
              <CapsuleAddCommandButton disabled={disabled} onClick={() => setDialogOpen(true)} />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

export function CapsuleCommandsMoreTrigger({
  disabled,
  className,
}: {
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      data-testid="capsule-commands-more"
      className={cn('max-lg:min-h-11 max-lg:size-11', className)}
      aria-label="More commands"
    >
      ⋯
    </Button>
  );
}
