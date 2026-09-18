import type { CapabilityFacts } from '@/product/capability';

/**
 * Capability facts a canonical fixture route can express.
 *
 * The fixture varies the *input* — what the session's pane is running and what
 * it was seen running — never the resolved capability state. A route that could
 * name a state directly would let a fixture assert a resolution the app never
 * performed, which is exactly what the presence model is supposed to decide.
 *
 *   /#/fixture/workspace?pane=claude.exe             → running it now
 *   /#/fixture/workspace?pane=zsh&observed=claude.exe → ran it, back at the shell
 *
 * Absent parameters mean "no observations", which is the untouched canonical
 * fixture — so the golden screenshots do not move.
 */
export function fixtureCapabilityFacts(search: string): CapabilityFacts | undefined {
  const params = new URLSearchParams(search);
  const pane = params.get('pane');
  if (!pane) {
    return undefined;
  }

  const observed = (params.get('observed') ?? '')
    .split(',')
    .map((command) => command.trim())
    .filter((command) => command.length > 0);

  return {
    sessionForegroundCommand: pane,
    // The current command has been observed too, exactly as the agent's
    // updates accumulate it.
    ...(observed.length > 0 ? { sessionObservedCommands: [...observed, pane] } : {}),
  };
}
