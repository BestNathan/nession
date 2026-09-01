import { Button } from '@/components/ui/button';
import { formatSeq } from '@/session-first/capsule/physKeys';
import {
  capsuleChainBarClass,
  capsuleMiniButtonClass,
} from '@/session-first/capsule/capsuleStyles';

interface CapsuleChainBarProps {
  buffer: string[];
  onCancel: () => void;
  onSend: () => void;
}

export function CapsuleChainBar({ buffer, onCancel, onSend }: CapsuleChainBarProps) {
  return (
    <div data-testid="capsule-chain-bar" className={capsuleChainBarClass}>
      <span className="text-muted-foreground">Chain:</span>
      <code className="font-mono text-primary">{buffer.map(formatSeq).join(' ')}</code>
      <div className="flex-1" />
      <Button variant="ghost" size="sm" className={capsuleMiniButtonClass} onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="default" size="sm" className={capsuleMiniButtonClass} onClick={onSend}>
        Send
      </Button>
    </div>
  );
}
