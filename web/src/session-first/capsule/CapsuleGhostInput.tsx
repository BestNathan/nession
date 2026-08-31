import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { useHistoryGhost } from '@/session-first/capsule/useHistoryGhost';

/** text-sm leading-5 + py-1.5 top/bottom (expanded) */
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
  /** Multi-line expanded layout uses taller padding / leading. */
  expanded?: boolean;
  className?: string;
}

export function CapsuleGhostInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Send input…',
  onEnter,
  onLineCountChange,
  expanded = false,
  className,
}: CapsuleGhostInputProps) {
  const { history } = useCommandHistory();
  const { ghostSuffix, acceptGhost, hasGhost } = useHistoryGhost(value, history);
  const [composing, setComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showGhost = hasGhost && !composing;
  const padY = expanded ? CAPSULE_PAD_Y_PX : 0;
  const linePx = expanded ? CAPSULE_LINE_PX : 32;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    const fromBreaks = Math.max(1, value.split('\n').length);
    const content = Math.max(0, el.scrollHeight - padY);
    const fromHeight = Math.max(1, Math.ceil(content / linePx));
    onLineCountChange?.(Math.max(fromBreaks, fromHeight));
  }, [value, onLineCountChange, padY, linePx]);

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
    <div className={cn('relative flex min-w-0 items-center', className)}>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 overflow-hidden text-sm',
          expanded ? 'px-1.5 py-1.5 leading-5' : 'flex items-center px-1.5 leading-8',
        )}
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
          'w-full resize-none overflow-y-auto border-0 bg-transparent text-sm text-foreground shadow-none',
          'outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0',
          'field-sizing-content',
          'transition-[padding,min-height,line-height,height] duration-300 ease-[var(--sf-ease)]',
          expanded
            ? 'min-h-8 px-1.5 py-1.5 leading-5'
            : 'h-8 min-h-8 px-1.5 py-0 leading-8',
        )}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  );
}
