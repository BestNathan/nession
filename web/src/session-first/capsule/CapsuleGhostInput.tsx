import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { useHistoryGhost } from '@/session-first/capsule/useHistoryGhost';

/** text-sm leading-5 + py-1.5 top/bottom */
export const CAPSULE_LINE_PX = 20;
export const CAPSULE_PAD_Y_PX = 12;
export const CAPSULE_MAX_LINES = 5;
export const CAPSULE_MAX_HEIGHT_PX =
  CAPSULE_LINE_PX * CAPSULE_MAX_LINES + CAPSULE_PAD_Y_PX;

interface CapsuleGhostInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  onEnter?: () => void;
  onLineCountChange?: (lineCount: number) => void;
  className?: string;
}

export function CapsuleGhostInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Send input…',
  onEnter,
  onLineCountChange,
  className,
}: CapsuleGhostInputProps) {
  const { history } = useCommandHistory();
  const { ghostSuffix, acceptGhost, hasGhost } = useHistoryGhost(value, history);
  const [composing, setComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showGhost = hasGhost && !composing;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    const fromBreaks = Math.max(1, value.split('\n').length);
    const content = Math.max(0, el.scrollHeight - CAPSULE_PAD_Y_PX);
    const fromHeight = Math.max(1, Math.ceil(content / CAPSULE_LINE_PX));
    onLineCountChange?.(Math.max(fromBreaks, fromHeight));
  }, [value, onLineCountChange]);

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
    <div className={cn('relative min-w-0', className)}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden px-2 py-1.5 text-sm leading-5"
      >
        <span className="whitespace-pre-wrap break-words text-transparent">{value}</span>
        {showGhost ? (
          <span
            data-testid="capsule-ghost-suffix"
            className="whitespace-pre-wrap break-words text-muted-foreground"
          >
            {ghostSuffix}
          </span>
        ) : null}
      </div>
      <textarea
        ref={textareaRef}
        data-testid="capsule-ghost-input"
        value={value}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        aria-autocomplete="inline"
        style={{ maxHeight: CAPSULE_MAX_HEIGHT_PX }}
        className={cn(
          'w-full resize-none overflow-y-auto bg-transparent px-2 py-1.5 text-sm leading-5',
          'text-foreground outline-none',
          'min-h-[var(--control-md)] field-sizing-content',
        )}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  );
}
