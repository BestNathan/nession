import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import { createDirectionPadTouchAdapter } from '../gesture/directionPadTouchAdapter';
import type { DirectionPadView } from '../gesture/directionPadView';

export type { DirectionPadView } from '../gesture/directionPadView';

export interface UseTerminalDirectionPadOptions {
  containerRef: RefObject<HTMLElement | null>;
  controller: TerminalController | null;
  /**
   * False when this client may not send input — an observer, a reconnect
   * banner, or a route switch. The gesture is cancelled the moment this turns
   * true.
   */
  inputDisabled?: boolean;
  /**
   * Where the App shell reserves its own edge-swipe band. The App layer
   * supplies the predicate because the band is shell navigation's, not the
   * terminal's; this hook only asks before arming.
   */
  touchEdgeReservation?: (target: EventTarget | null, clientX: number) => boolean;
}

/**
 * Mobile Terminal touch-and-hold directional navigation (#2657).
 *
 * Mounts the browser adapter in `directionPadTouchAdapter.ts` for the life of
 * the viewport (or until input is disabled) and mirrors its transient view
 * state into React. The adapter, not this hook, owns the listeners, the
 * gesture engine and the scroll lock.
 */
export function useTerminalDirectionPad({
  containerRef,
  controller,
  inputDisabled = false,
  touchEdgeReservation,
}: UseTerminalDirectionPadOptions): DirectionPadView | null {
  const [view, setView] = useState<DirectionPadView | null>(null);
  const reservationRef = useRef(touchEdgeReservation);
  reservationRef.current = touchEdgeReservation;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !controller || inputDisabled) {
      setView(null);
      return;
    }
    const adapter = createDirectionPadTouchAdapter({
      container,
      controller,
      touchEdgeReservation: (target, clientX) => (
        reservationRef.current?.(target, clientX) === true
      ),
      onView: setView,
    });
    return () => {
      adapter.dispose();
      setView(null);
    };
  }, [containerRef, controller, inputDisabled]);

  return view;
}
