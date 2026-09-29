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
} from './transcriptScrollConstants';

export function createTranscriptPullWheelHandler({
  scrollRef,
  enabled,
  wheelPullRef,
  applyPullPx,
  commitIfFilled,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  wheelPullRef: MutableRefObject<number>;
  applyPullPx: (next: number) => void;
  commitIfFilled: () => boolean;
}): WheelEventHandler<HTMLDivElement> {
  return (event) => {
    const root = scrollRef.current;
    if (!enabled || !root || !transcriptIsAtTopEdge(root)) {
      return;
    }
    const pullDown = event.deltaY > 0 && root.scrollTop <= 0;
    const pullUp = event.deltaY < 0;
    if (!pullDown && !pullUp) {
      return;
    }
    event.preventDefault();
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
