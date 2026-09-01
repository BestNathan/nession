import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import {
  capsuleFieldPadClass,
  capsuleFieldTypeClass,
} from '@/session-first/capsule/capsuleStyles';
import {
  maxFieldHeightPx,
  type ComposerMetrics,
} from '@/session-first/capsule/measure/types';
import { readComposerMetricsFromField } from '@/session-first/capsule/measure/readComposerMetrics';
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
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [metrics, setMetrics] = useState<ComposerMetrics | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showGhost = hasGhost && !composing;
  const minHeight = metrics?.controlHeight ?? 32;
  const maxHeight = metrics ? maxFieldHeightPx(metrics) : undefined;
  const heightEase = 'var(--motion-composer)';

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    const shell = el.closest('[data-testid="capsule-shell"]');
    if (!(shell instanceof HTMLElement)) {
      return;
    }

    const nextMetrics = readComposerMetricsFromField(shell, el);
    setMetrics(nextMetrics);

    const prev = el.style.height;
    el.style.height = 'auto';
    const measured = el.scrollHeight;
    el.style.height = prev;

    const nextHeight =
      value.length === 0
        ? nextMetrics.controlHeight
        : Math.min(
            Math.max(measured, nextMetrics.controlHeight),
            maxFieldHeightPx(nextMetrics),
          );
    setHeight((prevHeight) => (prevHeight === nextHeight ? prevHeight : nextHeight));
  }, [value]);

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
        style={{
          height: height ?? minHeight,
          maxHeight,
          transition: maxHeight ? `height ${heightEase}` : undefined,
        }}
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
