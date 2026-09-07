import { useLayoutEffect, useState, type RefObject } from 'react';
import { capsuleCommandsDismissLayerClass } from '@/session-first/capsule/capsuleStyles';

interface CapsuleCommandsDismissLayerProps {
  dockRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}

export function CapsuleCommandsDismissLayer({
  dockRef,
  onDismiss,
}: CapsuleCommandsDismissLayerProps) {
  const [bottomPx, setBottomPx] = useState(0);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    const host = dock?.closest('[data-terminal-capsule-host]');
    if (!dock || !(host instanceof HTMLElement)) {
      return;
    }

    const update = () => {
      const hostRect = host.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      setBottomPx(Math.max(0, hostRect.bottom - dockRect.top));
    };
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    observer.observe(host);
    update();
    return () => observer.disconnect();
  }, [dockRef]);

  return (
    <button
      type="button"
      data-testid="capsule-commands-dismiss-layer"
      aria-label="Close commands menu"
      className={capsuleCommandsDismissLayerClass}
      style={{ bottom: bottomPx }}
      onClick={onDismiss}
    />
  );
}
