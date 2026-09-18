import { Menu, PanelRight } from 'lucide-react';
import { ConnectionStatus as SessionConnectionStatus } from '@/product/session/components/ConnectionStatus';
import { Button } from '@/components/ui/button';
import { shellIconButtonClass } from '@/app/shellStyles';
import type { CapsuleExperience } from '@/product/terminal/capsule/types';
import type { DomainState } from '@/product/session/model/domainState';
import { resolveSessionChrome } from '@/product/session/model/sessionChrome';

// Re-exported for the six modules that import the surface type from here.
import type { Surface } from '@/product/workspace/patterns/SurfaceSwitcher';
export type { Surface };

/**
 * App-only since #748: the Web shell renders no header. Every prop here is one
 * the App branch actually reads — the web-only ones (agent label, agent
 * context, back-to-sessions, server micro-status) went with the branch rather
 * than surviving as dead parameters.
 */
export interface SessionHeaderProps {
  sessionName: string;
  state: DomainState;
  onOpenDrawer?: () => void;
  onOpenWorkspace?: () => void;
  /** App experience: no Terminal|Workspace switcher — the spatial model owns navigation. */
  experience?: CapsuleExperience;
}

interface MenuButtonOptions {
  label: string;
  testid: string;
  onClick: () => void;
  className: string;
}

/** Ghost menu button for the App header's Sessions affordance. */
function renderMenuButton({ label, testid, onClick, className }: MenuButtonOptions) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      aria-label={label}
      data-testid={testid}
      onClick={() => onClick()}
    >
      <Menu className="size-5" />
    </Button>
  );
}

export function SessionHeader({
  sessionName,
  state,
  onOpenDrawer,
  onOpenWorkspace,
  experience = 'app',
}: SessionHeaderProps) {
  const chrome = resolveSessionChrome(state);
  const title = (
    <h1 className="min-w-0 truncate font-mono text-base font-semibold">{sessionName}</h1>
  );
  if (experience === 'app') {
    return (
      <header
        data-testid="session-header-line"
        className="flex shrink-0 items-center gap-2 px-[var(--shell-space-3)] pt-[max(var(--shell-space-2),env(safe-area-inset-top))]"
      >
        {onOpenDrawer
          ? renderMenuButton({
              label: 'Sessions',
              testid: 'app-header-sessions',
              onClick: onOpenDrawer,
              className: shellIconButtonClass,
            })
          : null}
        {title}
        <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">
          {chrome.agent !== 'quiet' || chrome.connection !== 'quiet' ? (
            <SessionConnectionStatus state={state} />
          ) : null}
        </div>
        {onOpenWorkspace ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={shellIconButtonClass}
            aria-label="Workspace"
            data-testid="app-header-workspace"
            onClick={() => onOpenWorkspace()}
          >
            <PanelRight className="size-5" />
          </Button>
        ) : null}
      </header>
    );
  }
  // Web renders **no header at all** (#748, SC1). The shell is two columns; the
  // header's duties moved rather than disappearing — Session identity to the
  // selected row in the sidebar, agent reachability to that row's own metadata
  // (which already carried it, making the header's AgentContext a duplicate),
  // service and attachment state to the sidebar footer, and Workspace reach to
  // the floating surface capsule. `surface-switcher.md`'s ordering rule is
  // respected: the replacement shipped before this control was removed.
  return null;
}
