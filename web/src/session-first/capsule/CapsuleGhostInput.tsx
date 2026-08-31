import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { useHistoryGhost } from '@/session-first/capsule/useHistoryGhost';

interface CapsuleGhostInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  onEnter?: () => void;
  className?: string;
}

export function CapsuleGhostInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Send input…',
  onEnter,
  className,
}: CapsuleGhostInputProps) {
  const { history } = useCommandHistory();
  const { ghostSuffix, acceptGhost, hasGhost } = useHistoryGhost(value, history);
  const [composing, setComposing] = useState(false);

  const showGhost = hasGhost && !composing;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && showGhost) {
      event.preventDefault();
      onChange(acceptGhost());
      return;
    }
    if (event.key === 'Escape' && showGhost) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onEnter?.();
    }
  };

  return (
    <div className={cn('relative min-w-0 flex-1', className)}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-2 py-1 text-sm"
      >
        <span className="whitespace-pre text-transparent">{value}</span>
        {showGhost ? (
          <span data-testid="capsule-ghost-suffix" className="truncate text-muted-foreground">
            {ghostSuffix}
          </span>
        ) : null}
      </div>
      <textarea
        data-testid="capsule-ghost-input"
        value={value}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        aria-autocomplete="inline"
        className={cn(
          'w-full resize-none bg-transparent px-2 py-1 text-sm text-foreground outline-none',
          'min-h-[var(--control-md)] field-sizing-content max-h-24',
        )}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  );
}
