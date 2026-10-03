/**
 * The foreground command the Agent reports for the selected Session's pane.
 *
 *   /#/fixture/app?pane=claude.exe → the pane is running Claude Code
 *
 * The work-awareness states (#1347 SC-34/SC-35) are resolved from this input —
 * the same one the live app gets with every session update — and no canonical
 * route could produce it: the fixture's selected Session runs `bash`, so a
 * sensed-first `+` and the Work Ring were unreachable from every canonical
 * screen and had no coverage that could fail.
 *
 * It names the *input* — what the agent observed — rather than asking for a
 * rendering, on the line `fixtureSessions`, `fixtureStaleAgents` and
 * `fixtureCapabilityFacts` draw. Absent is the canonical route, so the existing
 * golden screenshots do not move.
 */
export function fixturePaneCommand(search: string): string | null {
  return new URLSearchParams(search).get('pane');
}
