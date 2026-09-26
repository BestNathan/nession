import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { secondaryAppClass, titleAppClass } from './appTypography';

export interface AppHomeProps {
  /** Opens the existing `CreateSessionDialog` — never a second creation flow. */
  onCreate: () => void;
  /** Leaves for the Sessions layer. The header carries the same affordance. */
  onBrowse: () => void;
  /** No Agent is online, so creation cannot succeed. */
  createDisabled: boolean;
}

/**
 * The App's root before a Session exists (#1082).
 *
 * The App used to have no such screen. `WorkspaceRegion` mounted the App
 * composition only when `selectedId !== null`, so with no Session the narrow
 * viewport fell back to the Web frame and the work area said "Select a session
 * to start working" — a status report with no action, and after the Sessions
 * drawer was dismissed, no way back to one either.
 *
 * `visual-language.md` §Empty states owns what replaces it: "An empty screen is
 * an invitation to act, not a status report." So the screen states what the
 * user can do and puts the control that does it on the screen, named the way
 * that control is named everywhere — **New Session**.
 *
 * Type is the App's own ramp (#1073): the screen-level heading is the `title`
 * role, which is the only role the App gives a page's own name. The supporting
 * line is `secondary` — "supporting but fully readable" — and deliberately not
 * `body`, which is the App's *control* role and would make prose read as an
 * action.
 */
export function AppHome({ onCreate, onBrowse, createDisabled }: AppHomeProps) {
  return (
    <div
      data-testid="app-home"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[var(--shell-space-4)] px-[var(--shell-space-4)] text-center"
    >
      <div className="flex flex-col gap-[var(--shell-space-1)]">
        <h1 className={cn('font-semibold', titleAppClass)}>Start a session</h1>
        <p className={secondaryAppClass}>Open a terminal workspace on an Agent.</p>
      </div>

      <div className="flex flex-col items-center gap-[var(--shell-space-2)]">
        <Button
          type="button"
          onClick={() => onCreate()}
          disabled={createDisabled}
          data-testid="app-home-new-session"
        >
          <Plus />
          New Session
        </Button>
        {/* A disabled control that does not say why is a dead end one click
            earlier. The explanation is the reason the *button* is unavailable,
            so it sits with the button rather than under the heading. */}
        {createDisabled ? (
          <p className={secondaryAppClass} data-testid="app-home-no-agent">
            No online Agent available
          </p>
        ) : null}
      </div>

      <Button
        type="button"
        variant="ghost"
        onClick={() => onBrowse()}
        data-testid="app-home-browse-sessions"
      >
        Browse sessions
      </Button>
    </div>
  );
}
