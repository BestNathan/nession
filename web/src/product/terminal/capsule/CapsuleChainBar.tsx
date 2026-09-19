/**
 * Physical-key chaining — the strip that shows keys accumulating into a chain
 * before it is sent or cancelled.
 *
 * **Implementation asset, not the product boundary.** It names no state of its
 * own in `docs/design/design-system/patterns/terminal-capsule.md`; that document
 * covers it under §Input modes, which lists "terminal-oriented modes such as
 * direct input, command/physical-key controls, history, paste, copy, and send"
 * and says they are "implementation tools beneath the product interaction
 * model". This is the implementation of physical-key control, and the pattern
 * it must not obstruct is the capsule's conversational/contextual one.
 *
 * Stated here because the pattern doc's §Implementation migration asks that
 * `InputComposer`-era assets "be treated as implementation assets to converge
 * rather than as the permanent product boundary" — and a reader who cannot tell
 * which files that covers will assume the opposite. Its tokens follow the same
 * rule as the rest of the capsule: `--terminal-capsule-*` from
 * `design/tokens/experience/{web,app}.json`.
 */
import { Button } from '@/components/ui/button';
import { formatSeq } from '@/product/terminal/capsule/physKeys';
import {
  capsuleChainBarClass,
  capsuleMiniButtonClass,
} from '@/product/terminal/capsule/capsuleStyles';

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
