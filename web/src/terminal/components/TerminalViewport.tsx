import { useRef, useEffect } from 'react';
import type { TerminalController } from '../controller/TerminalController';

/**
 * Pure DOM mount point for xterm.
 *
 * Owns a single container div; on mount (or when the controller changes) the
 * controller opens xterm inside it, and on unmount the controller is detached
 * and the container is cleared. The terminal-coloured background paints
 * whatever part of the container is not covered by the xterm mount element.
 */
export function TerminalViewport({ controller }: { controller: TerminalController | null }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !controller) { return; }
    controller.attach(container);
    return () => {
      controller.detach();
      container.innerHTML = '';
    };
  }, [controller]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-terminal-background"
    />
  );
}
