import { CapsuleCommandsRow } from '@/features/terminal/capsule/CapsuleCommandsRow';
import { useCapsuleContext } from '@/features/terminal/capsule/state/useCapsuleContext';

export function CommandsComposer() {
  const { commandsOpen, setCommandsOpen, disabled, sendText } = useCapsuleContext();

  return (
    <CapsuleCommandsRow
      sendText={sendText}
      disabled={disabled}
      commandsOpen={commandsOpen}
      onCommandsOpenChange={setCommandsOpen}
    />
  );
}
