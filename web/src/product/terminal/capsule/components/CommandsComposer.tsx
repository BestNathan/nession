import { CapsuleCommandsRow } from '@/product/terminal/capsule/CapsuleCommandsRow';
import { useCapsuleContext } from '@/product/terminal/capsule/state/useCapsuleContext';

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
