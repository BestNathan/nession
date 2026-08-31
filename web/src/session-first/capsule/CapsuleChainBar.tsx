import { Button } from '@/components/ui/button';
import { formatSeq } from '@/session-first/capsule/physKeys';

interface CapsuleChainBarProps {
  buffer: string[];
  onCancel: () => void;
  onSend: () => void;
}

export function CapsuleChainBar({ buffer, onCancel, onSend }: CapsuleChainBarProps) {
  return (
    <div
      data-testid="capsule-chain-bar"
      className="flex items-center gap-2 border-b border-border/60 bg-primary/10 px-2 py-1 text-xs"
    >
      <span className="text-muted-foreground">Chain:</span>
      <code className="font-mono text-primary">{buffer.map(formatSeq).join(' ')}</code>
      <div className="flex-1" />
      <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="default" size="sm" className="h-6 text-[10px]" onClick={onSend}>
        Send
      </Button>
    </div>
  );
}
