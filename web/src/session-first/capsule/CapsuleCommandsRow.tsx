import { useCapsuleCommands } from '@/session-first/capsule/useCapsuleCommands';
import { QUICK_MOBILE_KEYS } from '@/session-first/capsule/physKeys';
import { Button } from '@/components/ui/button';
import {
  CapsuleCommandsMoreTrigger,
  CapsuleCommandsPopover,
} from '@/session-first/capsule/CapsuleCommandsPopover';
import { CapsuleChainBar } from '@/session-first/capsule/CapsuleChainBar';

interface CapsuleCommandsRowProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  commandsOpen: boolean;
  onCommandsOpenChange: (open: boolean) => void;
}

export function CapsuleCommandsRow({
  sendText,
  disabled = false,
  commandsOpen,
  onCommandsOpenChange,
}: CapsuleCommandsRowProps) {
  const {
    chainBuffer,
    isChaining,
    handlePhysKey,
    cancelChain,
    sendChain,
  } = useCapsuleCommands(sendText);

  return (
    <div data-testid="capsule-commands-row" className="flex min-w-0 flex-1 flex-col">
      {isChaining ? (
        <CapsuleChainBar buffer={chainBuffer} onCancel={cancelChain} onSend={sendChain} />
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {QUICK_MOBILE_KEYS.map((keyDef) => (
          <Button
            key={keyDef.label}
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            data-testid={`capsule-quick-key-${keyDef.label}`}
            className="shrink-0 font-mono text-xs max-lg:min-h-11"
            onClick={() => handlePhysKey(keyDef.seq)}
            onContextMenu={(event) => event.preventDefault()}
          >
            {keyDef.label}
          </Button>
        ))}
        <CapsuleCommandsPopover
          open={commandsOpen}
          onOpenChange={onCommandsOpenChange}
          sendText={sendText}
          disabled={disabled}
          showPhysKeys
          trigger={<CapsuleCommandsMoreTrigger disabled={disabled} />}
        />
      </div>
    </div>
  );
}
