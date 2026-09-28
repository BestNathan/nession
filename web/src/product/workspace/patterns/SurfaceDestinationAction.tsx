import { LayoutPanelTop, SquareTerminal } from 'lucide-react';

export type Surface = 'terminal' | 'workspace';

export interface SurfaceDestinationActionProps {
  /**
   * Where activating takes the user — never the surface they are already on.
   * The current surface renders no action pointing at itself (#1204): the old
   * two-state switcher's "active segment = no-op" interaction is gone with it.
   */
  destination: Surface;
  onOpen: () => void;
}

const DESTINATIONS = {
  terminal: { icon: SquareTerminal, label: 'Open Terminal' },
  workspace: { icon: LayoutPanelTop, label: 'Open Workspace' },
} as const;

/**
 * The Web's reciprocal Terminal ↔ Workspace route (#1204): one compact circular
 * action beside the current surface's own bottom control — right of the
 * TerminalCapsule on Terminal, left of the capability dock on Workspace.
 *
 * It names the *destination*, not the current state, so a surface never carries
 * a permanent control telling the user where they already are. That is what
 * lets it be quieter than the local primary control (Capsule/Dock): same
 * floating-surface family, muted icon at rest, foreground on hover/focus, no
 * selected fill, no label, no badge.
 *
 * A plain button, deliberately not the retired `Tabs` pattern: there is exactly
 * one action and it navigates on activation — no selected state exists for tab
 * semantics to model.
 *
 * Composition is the shell's: the action arrives as a slot beside the Capsule
 * or the dock, so this pattern never imports app routing and the Capsule/Dock
 * never learn what a surface is. `pointer-events-auto` is on the button itself
 * because the capsule's dock region is `pointer-events-none`; on the Workspace
 * side it is inert but harmless.
 */
export function SurfaceDestinationAction({
  destination,
  onOpen,
}: SurfaceDestinationActionProps) {
  const { icon: Icon, label } = DESTINATIONS[destination];
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={`surface-action-open-${destination}`}
      onClick={() => onOpen()}
      className="pointer-events-auto flex size-[length:var(--control-md)] shrink-0 items-center justify-center rounded-full bg-[color:var(--terminal-capsule-surface)] text-muted-foreground shadow-[var(--elevation-floating)] backdrop-blur-md transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)] hover:text-foreground focus-visible:text-foreground motion-reduce:transition-none"
    >
      <Icon className="size-[length:var(--icon-md)]" aria-hidden />
    </button>
  );
}
