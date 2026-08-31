import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import {
  CAPSULE_LINE_PX,
  CAPSULE_MAX_HEIGHT_PX,
  CAPSULE_PAD_Y_PX,
  CAPSULE_SINGLE_HEIGHT_PX,
  capsuleFieldPadClass,
  capsuleFieldTypeClass,
} from '@/session-first/capsule/capsuleStyles';
import { useHistoryGhost } from '@/session-first/capsule/useHistoryGhost';

export {
  CAPSULE_LINE_PX,
  CAPSULE_MAX_HEIGHT_PX,
  CAPSULE_MAX_LINES,
  CAPSULE_PAD_Y_PX,
  CAPSULE_SINGLE_HEIGHT_PX,
} from '@/session-first/capsule/capsuleStyles';

const HEIGHT_EASE = 'height 280ms cubic-bezier(0.22, 1, 0.36, 1)';

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
  const [height, setHeight] = useState(CAPSULE_SINGLE_HEIGHT_PX);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showGhost = hasGhost && !composing;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    const fromBreaks = Math.max(1, value.split('\n').length);
    const prev = el.style.height;
    el.style.height = 'auto';
    const measured = el.scrollHeight;
    el.style.height = prev;

    const fromHeight = Math.max(
      1,
      Math.ceil(Math.max(0, measured - CAPSULE_PAD_Y_PX) / CAPSULE_LINE_PX),
    );
    const lines = Math.max(fromBreaks, fromHeight);
    onLineCountChange?.(lines);

    const nextHeight = Math.min(
      Math.max(measured, CAPSULE_SINGLE_HEIGHT_PX),
      CAPSULE_MAX_HEIGHT_PX,
    );
    setHeight((prevHeight) => (prevHeight === nextHeight ? prevHeight : nextHeight));
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
    <div className={cn('relative min-w-0 flex-1', className)}>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 overflow-hidden',
          capsuleFieldPadClass,
          capsuleFieldTypeClass,
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
        style={{ height, maxHeight: CAPSULE_MAX_HEIGHT_PX, transition: HEIGHT_EASE }}
        className={cn(
          'w-full resize-none overflow-y-auto border-0 bg-transparent shadow-none',
          capsuleFieldPadClass,
          capsuleFieldTypeClass,
          'text-foreground placeholder:text-muted-foreground',
          'outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0',
        )}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  );
}
