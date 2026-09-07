import { useCallback, useState } from 'react';
import { X } from 'lucide-react';
import { PRESETS } from '@/components/quickCommands';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  capsuleCaptionTextClass,
  capsuleCommandsPanelClass,
  capsuleCommandsPanelHeaderClass,
  capsuleCommandsPanelListClass,
  capsulePopoverBodyClass,
  capsulePopoverItemClass,
} from '@/session-first/capsule/capsuleStyles';
import { cn } from '@/lib/utils';
import { CapsuleAddCommandButton, CapsuleAddCommandDialog, CapsuleDeleteButton } from '@/session-first/capsule/CapsuleAddCommandDialog';
import { CapsuleChainBar } from '@/session-first/capsule/CapsuleChainBar';
import { PhysKeyRow } from '@/session-first/capsule/PhysKeyRow';
import { useCapsuleCommands } from '@/session-first/capsule/useCapsuleCommands';

interface CapsuleCommandsPanelProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  showPhysKeys: boolean;
  onClose: () => void;
}

export function CapsuleCommandsPanel({
  sendText,
  disabled = false,
  showPhysKeys,
  onClose,
}: CapsuleCommandsPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const commands = useCapsuleCommands(sendText);
  const {
    allCommands,
    presetIds,
    chainBuffer,
    isChaining,
    handleRun: runCommand,
    handlePhysKey,
    handleChainStart,
    handleChainAdd,
    cancelChain,
    sendChain,
    deleteCommand,
    addCommand,
  } = commands;

  const handleRun = useCallback(
    (command: Parameters<typeof runCommand>[0]) => {
      runCommand(command);
      onClose();
    },
    [runCommand, onClose],
  );

  const openAddCommandDialog = useCallback(() => {
    onClose();
    setDialogOpen(true);
  }, [onClose]);

  return (
    <>
      <div data-testid="capsule-commands-panel" className={capsuleCommandsPanelClass}>
        <div className={capsuleCommandsPanelHeaderClass}>
          <h2 className={cn(capsuleCaptionTextClass, 'font-medium')}>Quick commands</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close commands"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
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
          <div className={capsuleCommandsPanelListClass}>
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
            <CapsuleAddCommandButton disabled={disabled} onClick={openAddCommandDialog} />
          </div>
        </div>
      </div>
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
