import type { Session } from '@/types';

/**
 * The selected row with the route's reported pane command.
 *
 * `?pane=` is a fixture input the shell cannot otherwise be given without a
 * live Agent; the surface decides what to draw from the same Session shape it
 * already receives.
 */
export function fixtureSelectedSession(
  sessions: Session[],
  selectedId: string | null,
  paneCommand: string | null | undefined,
): Session | null {
  const base = sessions.find((session) => session.session_id === selectedId) ?? null;
  return base && paneCommand ? { ...base, foreground_command: paneCommand } : base;
}
