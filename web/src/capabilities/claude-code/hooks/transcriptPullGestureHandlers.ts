import type {
  MutableRefObject,
  PointerEvent,
  PointerEventHandler,
  RefObject,
  WheelEventHandler,
} from 'react';
import {
  TRANSCRIPT_PULL_MAX_PX,
  TRANSCRIPT_PULL_TRIGGER_PX,
  transcriptIsAtTopEdge,
  type TranscriptAnchor,
} from './transcriptScrollConstants';

export function createTranscriptPullWheelHandler({
  scrollRef,
  enabled,
  wheelPullRef,
  gestureAnchorRef,
  applyPullPx,
  commitIfFilled,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  wheelPullRef: MutableRefObject<number>;
  gestureAnchorRef: MutableRefObject<TranscriptAnchor | null>;
  applyPullPx: (next: number) => void;
  commitIfFilled: () => boolean;
}): WheelEventHandler<HTMLDivElement> {
  return (event) => {
    const root = scrollRef.current;
    // A wheel pull is only a pull while wheeling *toward older* content —
    // with natural scrolling that is `deltaY < 0`. Wheeling toward newer
    // messages at the exact top is an ordinary scroll that goes nowhere, not
    // a pull; anything accumulated so far is stale the moment the gesture
    // reverses or leaves the edge.
    const stale =
      !enabled || !root || !transcriptIsAtTopEdge(root) || event.deltaY > 0;
    if (stale) {
      if (wheelPullRef.current > 0) {
        wheelPullRef.current = 0;
        applyPullPx(0);
      }
      return;
    }
    if (event.deltaY === 0) {
      return;
    }
    // No preventDefault: React attaches wheel listeners as passive at the
    // root, so the call is a no-op that only logs an intervention. At the top
    // edge the container cannot scroll further up anyway.
    if (wheelPullRef.current === 0) {
      // The wheel gesture's first fill — the last moment the layout is in its
      // resting state. The anchor the commit hands over is measured here.
      gestureAnchorRef.current = {
        scrollHeight: root.scrollHeight,
        scrollTop: root.scrollTop,
      };
    }
    const step = Math.min(24, Math.abs(event.deltaY));
    wheelPullRef.current = Math.min(
      TRANSCRIPT_PULL_MAX_PX,
      wheelPullRef.current + step,
    );
    applyPullPx(wheelPullRef.current);
    if (wheelPullRef.current >= TRANSCRIPT_PULL_TRIGGER_PX) {
      commitIfFilled();
    }
  };
}

export function createTranscriptPullPointerHandlers({
  enabled,
  beginPull,
  movePull,
  finishPull,
}: {
  enabled: boolean;
  beginPull: (clientY: number) => void;
  movePull: (clientY: number, preventDefault?: () => void) => void;
  finishPull: (event: PointerEvent<HTMLDivElement>) => void;
}): {
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
} {
  const onPointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!enabled || (event.button ?? 0) !== 0) {
      return;
    }
    event.stopPropagation();
    beginPull(event.clientY);
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
    movePull(event.clientY, () => event.preventDefault());
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: finishPull,
    onPointerCancel: finishPull,
  };
}
