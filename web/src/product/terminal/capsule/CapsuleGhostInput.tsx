import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '@/shared/lib/utils';
import { useCommandHistory } from '@/product/terminal/hooks/useCommandHistory';
import {
  capsuleFieldPadClass,
  capsuleFieldTypeClass,
} from '@/product/terminal/capsule/capsuleStyles';
import {
  maxFieldHeightPx,
  type ComposerMetrics,
} from '@/product/terminal/capsule/measure/types';
import { readComposerMetricsFromField } from '@/product/terminal/capsule/measure/readComposerMetrics';
import { useHistoryGhost } from '@/product/terminal/capsule/useHistoryGhost';

interface CapsuleGhostInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  onEnter?: () => void;
  /**
   * Fires when the field takes focus.
   *
   * The field reports the event and decides nothing: whether focus on the
   * composer *means* anything — taking the keyboard back from a projection —
   * is the capsule's question, and it is the capsule that answers it (#1034).
   */
  onFocus?: () => void;
  /**
   * The field element, for a caller that has to take focus **away** from it.
   *
   * Dismissing a soft keyboard is an imperative `blur()`, so the capsule needs
   * the element. It reaches the field from above rather than the field learning
   * why it is being blurred — same division as `onFocus`, and the reason this is
   * a ref rather than a `blur()` prop.
   */
  fieldRef?: RefObject<HTMLTextAreaElement>;
  className?: string;
}

export function CapsuleGhostInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Send input…',
  onEnter,
  onFocus,
  fieldRef,
  className,
}: CapsuleGhostInputProps) {
  const { history } = useCommandHistory();
  const { ghostSuffix, acceptGhost, hasGhost } = useHistoryGhost(value, history);
  const [composing, setComposing] = useState(false);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [metrics, setMetrics] = useState<ComposerMetrics | null>(null);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  // One element, two interests in it — the field measures its own height and the
  // capsule may need to blur it. A caller that supplies a ref gets the same node
  // the measurement reads; a caller that does not is unaffected.
  const textareaRef = fieldRef ?? ownRef;

  const showGhost = hasGhost && !composing;
  const minHeight = metrics?.controlHeight ?? 32;
  const maxHeight = metrics ? maxFieldHeightPx(metrics) : undefined;
  const heightEase = 'var(--motion-terminal-capsule)';

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
    // `textareaRef` is a dependency because the effect reads it, and it is
    // stable in both of its shapes: the field's own `useRef`, or the one the
    // capsule passed down for the lifetime of the capsule.
  }, [textareaRef, value]);

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
    <div className={cn('relative flex min-w-0 flex-1 items-center', className)}>
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
        onFocus={onFocus}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  );
}
