import { useRef, useLayoutEffect } from 'react';
import { cn } from '@/shared/lib/utils';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import { registerWorkspaceFileLinkProvider } from '@/product/terminal/workspaceFileLinks';

/**
 * The terminal well's box and inset, exported so a second xterm mount cannot
 * drift from this one.
 *
 * `FixtureTerminal` mounts a bare xterm into the same `TerminalSurface` (it has
 * no transport, so it cannot use a `TerminalController`), and it used to spell
 * its own `h-full w-full`. With a zero inset on both sides that happened to
 * agree; the moment the well gained the Experience inset, two spellings meant
 * the canonical screens drew a terminal the product no longer draws — and the
 * inset would then be in no visual baseline at all.
 *
 * ## The inset
 *
 * Three sides take the Experience inset (`experience.{web,app}.terminal.pad*`,
 * `--nession-terminal-pad-x` / `--nession-terminal-pad-y`): the mockup's `.term` draws
 * `padding: 18px 18px 52px`, and this box-border element spends those as real
 * inset so the first line is not flush against the well's edge.
 *
 * The fourth is **not** the mockup's literal. Its 52px bottom is the resting
 * capsule's own box (14px bottom margin + a 36px capsule + 2), i.e. the
 * clearance already measured into `--nession-local-terminal-content-bottom-inset` from the
 * live capsule geometry — and the capsule here is not the mockup's 26px control
 * on a 14px margin, it is the contract's `control.md` band, so the real
 * clearance differs and is the number that must win. Freezing a reserve instead
 * would be the anti-pattern `terminal-surface.md` names outright: "shrink the
 * terminal grid with large fixed padding to reserve hypothetical UI".
 */
export const terminalViewportBoxClass = 'h-full w-full box-border bg-terminal-background';

/** The Experience inset, as a class: `px` plus top only — see the note above. */
export const terminalViewportInsetClass =
  'px-[length:var(--nession-terminal-pad-x)] pt-[length:var(--nession-terminal-pad-y)]';

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
  onOpenWorkspaceFile,
}: {
  controller: TerminalController | null;
  onOpenWorkspaceFile?: (path: string, line?: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const linkHandlerRef = useRef(onOpenWorkspaceFile);
  linkHandlerRef.current = onOpenWorkspaceFile;

  // Mount/unmount only. A transport swap is pushed to the controller by the
  // SessionRuntime itself (#1309) — no epoch prop, no React-driven rewire.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !controller) { return; }
    controller.attach(container);
    const term = controller.terminal;
    const linkDisposable =
      term && linkHandlerRef.current
        ? registerWorkspaceFileLinkProvider(term, (path, line) => {
            linkHandlerRef.current?.(path, line);
          })
        : undefined;
    return () => {
      linkDisposable?.dispose();
      controller.detach();
    };
  }, [controller]);

  return (
    <div
      ref={containerRef}
      data-terminal-viewport
      className={cn(terminalViewportBoxClass, terminalViewportInsetClass)}
      style={{ paddingBottom: 'var(--nession-local-terminal-content-bottom-inset, 0px)' }}
    />
  );
}
