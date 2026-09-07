import { forwardRef, useCallback, useState, type ButtonHTMLAttributes } from 'react';
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  capsuleCaptionTextClass,
  capsuleIconButtonClass,
  capsulePopoverBodyClass,
  capsulePopoverHeaderClass,
  capsulePopoverItemClass,
  capsulePopoverPanelClass,
  capsuleSheetContentClass,
  capsuleSheetOverlayClass,
} from '@/session-first/capsule/capsuleStyles';
import { readPopoverSideOffset } from '@/session-first/capsule/measure/readPopoverSideOffset';
import { cn } from '@/lib/utils';
import { CapsuleAddCommandButton, CapsuleAddCommandDialog, CapsuleDeleteButton } from '@/session-first/capsule/CapsuleAddCommandDialog';
import { CapsuleChainBar } from '@/session-first/capsule/CapsuleChainBar';
import { PhysKeyRow } from '@/session-first/capsule/PhysKeyRow';
import { useCapsuleCommands } from '@/session-first/capsule/useCapsuleCommands';

type CapsuleCommandsPresentation = 'popover' | 'sheet';

interface CapsuleCommandsPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sendText: (text: string) => void;
  disabled?: boolean;
  showPhysKeys: boolean;
  trigger?: React.ReactElement;
  /** Sheet avoids mobile popover touch-dismiss flicker on the more trigger. */
  presentation?: CapsuleCommandsPresentation;
}

interface CapsuleCommandsPanelBodyProps {
  disabled: boolean;
  showPhysKeys: boolean;
  onAddCommandClick: () => void;
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

function CapsuleCommandsPanelBody({
  disabled,
  showPhysKeys,
  onAddCommandClick,
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
  return (
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
        <CapsuleAddCommandButton disabled={disabled} onClick={onAddCommandClick} />
      </div>
    </div>
  );
}

export function CapsuleCommandsPopover({
  open,
  onOpenChange,
  sendText,
  disabled = false,
  showPhysKeys,
  trigger,
  presentation = 'popover',
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

  const panelBody = (
    <CapsuleCommandsPanelBody
      disabled={disabled}
      showPhysKeys={showPhysKeys}
      onAddCommandClick={openAddCommandDialog}
      {...commands}
      handleRun={handleRun}
      handlePhysKey={sendPhysKey}
      sendChain={sendCommandChain}
    />
  );

  const addCommandDialog = (
    <CapsuleAddCommandDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      disabled={disabled}
      onAddPlain={(label, command) => commands.addCommand(label, command, false)}
      onAddCombo={(label, seq) => commands.addCommand(label, seq, true)}
    />
  );

  if (presentation === 'sheet') {
    return (
      <>
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetTrigger
            nativeButton
            disabled={disabled}
            render={triggerElement}
          />
          <SheetContent
            side="bottom"
            overlayClassName={capsuleSheetOverlayClass}
            className={cn(
              capsulePopoverPanelClass,
              capsuleSheetContentClass,
              'w-full max-w-none rounded-t-xl pb-[env(safe-area-inset-bottom)]',
            )}
          >
            <SheetHeader className={cn(capsulePopoverHeaderClass, 'border-b border-border/60 text-left')}>
              <SheetTitle>Quick commands</SheetTitle>
            </SheetHeader>
            {panelBody}
          </SheetContent>
        </Sheet>
        {addCommandDialog}
      </>
    );
  }

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
          {panelBody}
        </PopoverContent>
      </Popover>
      {addCommandDialog}
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
