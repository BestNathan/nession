import { useState, type ButtonHTMLAttributes } from 'react';
import { MoreHorizontal, Terminal } from 'lucide-react';
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
import {
  capsuleCaptionTextClass,
  capsuleIconButtonClass,
  capsulePopoverBodyClass,
  capsulePopoverHeaderClass,
  capsulePopoverItemClass,
  capsulePopoverPanelClass,
} from '@/session-first/capsule/capsuleStyles';
import { readPopoverSideOffset } from '@/session-first/capsule/measure/readPopoverSideOffset';
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
      disabled={disabled}
      data-testid="capsule-commands-trigger"
      className={cn(capsuleIconButtonClass, 'rounded-lg')}
      aria-label="Quick commands"
    >
      <Terminal />
    </Button>
  );

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          nativeButton
          disabled={disabled}
          render={trigger ?? defaultTrigger}
        />
        <PopoverContent
          align="end"
          side="top"
          sideOffset={readPopoverSideOffset()}
          className={capsulePopoverPanelClass}
        >
          <PopoverHeader className={cn(capsulePopoverHeaderClass, 'border-b border-border/60')}>
            <PopoverTitle>Commands</PopoverTitle>
          </PopoverHeader>
          <div className={capsulePopoverBodyClass}>
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
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid="capsule-commands-more"
      className={cn(
        capsuleIconButtonClass,
        'inline-flex items-center justify-center rounded-full',
        className,
      )}
      aria-label="More commands"
      {...rest}
    >
      <MoreHorizontal className="size-[length:var(--icon-md)]" />
    </button>
  );
}
