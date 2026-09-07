import { useCapsuleCommands } from '@/session-first/capsule/useCapsuleCommands';
import { QUICK_MOBILE_KEYS } from '@/session-first/capsule/physKeys';
import { Button } from '@/components/ui/button';
import { CapsuleCommandsMoreTrigger } from '@/session-first/capsule/CapsuleCommandsPopover';
import { CapsuleChainBar } from '@/session-first/capsule/CapsuleChainBar';
import {
  capsuleCommandsMoreClass,
  capsuleCommandsRowClass,
  capsuleCommandsScrollClass,
  capsuleQuickKeyButtonClass,
  capsuleQuickKeyRowClass,
} from '@/session-first/capsule/capsuleStyles';
import { cn } from '@/lib/utils';

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
      <div className={cn(capsuleCommandsRowClass, commandsOpen && 'justify-end')}>
        {!commandsOpen ? (
          <div className={cn(capsuleCommandsScrollClass, capsuleQuickKeyRowClass)}>
            {QUICK_MOBILE_KEYS.map((keyDef) => (
              <Button
                key={keyDef.label}
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                data-testid={`capsule-quick-key-${keyDef.label}`}
                className={capsuleQuickKeyButtonClass}
                onClick={() => handlePhysKey(keyDef.seq)}
                onContextMenu={(event) => event.preventDefault()}
              >
                {keyDef.label}
              </Button>
            ))}
          </div>
        ) : null}
        <div className={capsuleCommandsMoreClass}>
          <CapsuleCommandsMoreTrigger
            disabled={disabled}
            aria-expanded={commandsOpen}
            onClick={() => onCommandsOpenChange(!commandsOpen)}
          />
        </div>
      </div>
    </div>
  );
}
