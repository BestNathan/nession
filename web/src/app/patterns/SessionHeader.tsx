import { Menu, PanelRight } from 'lucide-react';
import { ConnectionStatus as SessionConnectionStatus } from '@/product/session/patterns/ConnectionStatus';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { shellIconButtonClass } from '@/app/shellStyles';
import { metadataAppClass, titleAppClass } from '@/app/experiences/app/appTypography';
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

/**
 * The App header band's geometry.
 *
 * Exported because the App now has a second bar that is the *same band*: the
 * no-Session home's (#1082). They never render together — one bar per depth,
 * and the home is a depth — but they do replace each other at the same
 * position, so a difference in padding or safe-area handling would show up as
 * the chrome jumping when a Session is selected. Sharing the string is what
 * makes that impossible rather than merely unlikely.
 */
export const appHeaderBandClass =
  'flex shrink-0 items-center gap-2 px-[var(--shell-space-3)] pt-[max(var(--shell-space-2),env(safe-area-inset-top))]';

/**
 * The Sessions affordance the App header carries.
 *
 * Both bars render this rather than each drawing their own, so the affordance
 * the user learns in one is literally the control in the other — same testid
 * included. They are never mounted at once, so the testid stays unique.
 */
export function SessionsMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={shellIconButtonClass}
      aria-label="Sessions"
      data-testid="app-header-sessions"
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
  // Session identity is product text, and the criterion names "Session name" in
  // the same breath as the page title (#1050 stage 4). It was monospaced here
  // while the *same* name is set in the product face on the Sessions row it was
  // chosen from — one string, two families, decided by which screen it is on.
  const title = (
    <h1 className={cn('min-w-0 truncate font-semibold', titleAppClass)}>
      {sessionName}
    </h1>
  );
  if (experience === 'app') {
    return (
      <header data-testid="session-header-line" className={appHeaderBandClass}>
        {onOpenDrawer ? <SessionsMenuButton onClick={onOpenDrawer} /> : null}
        {title}
        {/* The status member: `ConnectionStatus` renders channel words and their
            copy ("exited", "Agent offline", "Attach failed"). The Metadata role
            owns "status details", so the wrapper does not set the family — it
            was the `font-mono` here, not the child, that made this line read as
            technical (#1050 stage 4). The size follows the same role (#1073):
            the `text-xs` that stood here was a Tailwind default that happened to
            equal the App's metadata value, which is not the same as being owned
            by it. The children set their own size, so this names the level the
            member sits at rather than restating every child. */}
        <div
          data-testid="session-header-status"
          className={cn('flex min-w-0 flex-1 items-center gap-2', metadataAppClass)}
        >
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
