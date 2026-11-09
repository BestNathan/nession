/**
 * The operation a fixture route opens (#3089).
 *
 * A browser Case needs the Web/App Attach and Session-creation surfaces
 * reachable without a live Agent. The route names the operation; the surface
 * decides what to draw, exactly as the other fixture inputs do for status,
 * metadata and Projects.
 */
export type FixtureOperation =
  | 'attach'
  | 'attach-settings'
  | 'create-session'
  | null;

export function fixtureOperation(search: string): FixtureOperation {
  const requested = new URLSearchParams(search).get('operation');
  if (
    requested === 'attach' ||
    requested === 'attach-settings' ||
    requested === 'create-session'
  ) {
    return requested;
  }
  return null;
}
