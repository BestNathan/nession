import { CapsuleCommandsRow } from '@/session-first/capsule/CapsuleCommandsRow';
import { useCapsuleContext } from '@/session-first/capsule/state/useCapsuleContext';

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
