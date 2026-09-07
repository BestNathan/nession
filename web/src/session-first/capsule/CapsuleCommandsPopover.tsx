import { forwardRef, useCallback, useState, type ButtonHTMLAttributes } from 'react';
import { MoreHorizontal, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  capsuleIconButtonClass,
  capsulePopoverHeaderClass,
  capsulePopoverPanelClass,
} from '@/session-first/capsule/capsuleStyles';
import { readPopoverSideOffset } from '@/session-first/capsule/measure/readPopoverSideOffset';
import { cn } from '@/lib/utils';
import { CapsuleAddCommandDialog } from '@/session-first/capsule/CapsuleAddCommandDialog';
import { CapsuleCommandsPanelBody } from '@/session-first/capsule/CapsuleCommandsPanelBody';
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
  const commands = useCapsuleCommands(sendText);

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

  const triggerElement = trigger ?? defaultTrigger;
  const {
    handleRun: runCommand,
    handlePhysKey: sendPhysKey,
    sendChain: sendCommandChain,
    addCommand,
    ...panelBodyProps
  } = commands;
  const handleRun = useCallback(
    (command: Parameters<typeof runCommand>[0]) => {
      runCommand(command);
      onOpenChange(false);
    },
    [runCommand, onOpenChange],
  );
  const openAddCommandDialog = useCallback(() => {
    onOpenChange(false);
    setDialogOpen(true);
  }, [onOpenChange]);

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          nativeButton
          disabled={disabled}
          render={triggerElement}
        />
        <PopoverContent
          align="end"
          side="top"
          sideOffset={readPopoverSideOffset()}
          className={capsulePopoverPanelClass}
        >
          <PopoverHeader className={cn(capsulePopoverHeaderClass, 'border-b border-border/60')}>
            <PopoverTitle>Quick commands</PopoverTitle>
          </PopoverHeader>
          <CapsuleCommandsPanelBody
            disabled={disabled}
            showPhysKeys={showPhysKeys}
            onAddCommandClick={openAddCommandDialog}
            listClassName="min-h-0 flex-1 overflow-y-auto"
            handleRun={handleRun}
            handlePhysKey={sendPhysKey}
            sendChain={sendCommandChain}
            {...panelBodyProps}
          />
        </PopoverContent>
      </Popover>
      <CapsuleAddCommandDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        disabled={disabled}
        onAddPlain={(label, command) => addCommand(label, command, false)}
        onAddCombo={(label, seq) => addCommand(label, seq, true)}
      />
    </>
  );
}

export const CapsuleCommandsMoreTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    disabled?: boolean;
  }
>(function CapsuleCommandsMoreTrigger({ disabled, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
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
});
