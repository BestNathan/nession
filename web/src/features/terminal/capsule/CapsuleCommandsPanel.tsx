import { useCallback, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  capsuleCommandsPanelClass,
  capsuleCommandsPanelHeaderClass,
} from '@/features/terminal/capsule/capsuleStyles';
import { CapsuleAddCommandDialog } from '@/features/terminal/capsule/CapsuleAddCommandDialog';
import { CapsuleCommandsPanelBody } from '@/features/terminal/capsule/CapsuleCommandsPanelBody';
import { useCapsuleCommands } from '@/features/terminal/capsule/useCapsuleCommands';

interface CapsuleCommandsPanelProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  onClose: () => void;
}

export function CapsuleCommandsPanel({
  sendText,
  disabled = false,
  onClose,
}: CapsuleCommandsPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const commands = useCapsuleCommands(sendText);
  const { handleRun: runCommand, addCommand, ...panelBodyProps } = commands;

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
        <CapsuleCommandsPanelBody
          disabled={disabled}
          layout="overlay"
          onAddCommandClick={openAddCommandDialog}
          handleRun={handleRun}
          {...panelBodyProps}
        />
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
