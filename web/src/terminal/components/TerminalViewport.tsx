import { useRef, useLayoutEffect } from 'react';
import type { TerminalController } from '../controller/TerminalController';

/**
 * Pure DOM mount point for xterm.
 *
 * Owns a single container div; on mount (or when the controller changes) the
 * controller opens xterm inside it, and on unmount the controller is detached
 * and the container is cleared. The terminal-coloured background paints
 * whatever part of the container is not covered by the xterm mount element.
 */
export function TerminalViewport({
  controller,
  transportEpoch = 0,
}: {
  controller: TerminalController | null;
  /** Bump when the P2P socket identity changes so ConnectionManager rebinds. */
  transportEpoch?: string | number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !controller) { return; }
    controller.attach(container);
    return () => {
      controller.detach();
    };
  }, [controller, transportEpoch]);

  return (
    <div
      ref={containerRef}
      data-terminal-viewport
      className="h-full w-full box-border bg-terminal-background"
      style={{ paddingBottom: 'var(--terminal-content-bottom-inset, 0px)' }}
    />
  );
}
