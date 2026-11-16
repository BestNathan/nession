import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { KEYBOARD_AVOIDANCE_SCROLLPORT_ATTRIBUTE } from '@/platform/viewport/appViewport';
import { KeyboardAvoidanceScroller } from './keyboardAvoidanceScroller';

export interface AppKeyboardAvoidanceScrollportProps {
  /**
   * Whether this scrollport belongs to the layer the user is currently in.
   * An inactive layer releases its focus target (dismissing the keyboard)
   * instead of leaving a hidden input owning the visible keyboard.
   */
  active: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * The App Experience's active-layer keyboard-avoidance scroll ancestor (#3523).
 *
 * The soft keyboard changes the **visible** region, not the Terminal's layout
 * height. The ephemeral bottom extent lives after the measured work surface, so
 * the Terminal well, xterm's observed content box and PTY rows never change;
 * the focused Capsule composer or mobile-IME caret is revealed with a real,
 * bounded outer `scrollTop`. Gesture ownership is decided at axis lock inside
 * `KeyboardAvoidanceScroller`, so the same delta never reaches both the page
 * and xterm's own history path.
 */
export function AppKeyboardAvoidanceScrollport({
  active,
  children,
  className,
}: AppKeyboardAvoidanceScrollportProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const extentRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<KeyboardAvoidanceScroller | null>(null);
  // The mount effect must not re-run when the layer changes; the separate
  // effect below forwards the new state to the same imperative owner.
  const activeRef = useRef(active);
  activeRef.current = active;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const extent = extentRef.current;
    if (!root || !extent) {
      return;
    }
    const scroller = new KeyboardAvoidanceScroller(root, extent);
    scroller.setActive(activeRef.current);
    scroller.attach();
    scroller.setActive(activeRef.current);
    scrollerRef.current = scroller;
    return () => {
      scrollerRef.current = null;
      scroller.detach();
    };
  }, []);

  useEffect(() => {
    scrollerRef.current?.setActive(active);
  }, [active]);

  // The frame keeps `overflow-hidden` at rest; only a legal range switches it
  // to `auto` (imperatively), so the App never owns a generic outer scroll.
  return (
    <div
      ref={rootRef}
      data-testid="app-keyboard-avoidance-scrollport"
      {...{ [KEYBOARD_AVOIDANCE_SCROLLPORT_ATTRIBUTE]: '' }}
      className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden', className)}
    >
      <div
        data-testid="app-keyboard-avoidance-content"
        className="flex h-full min-h-0 shrink-0 flex-col"
      >
        {children}
      </div>
      <div
        ref={extentRef}
        aria-hidden
        data-testid="app-keyboard-avoidance-extent"
        className="shrink-0"
        style={{ height: 0 }}
      />
    </div>
  );
}
