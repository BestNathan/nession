/**
 * The Claude Code capability's stable identity.
 *
 * Separate from `contribution.tsx` so a component inside the capability can
 * name the capability without importing the module that imports it — the
 * contribution registers the component, and a title read through that edge
 * would be a cycle. The values themselves still have exactly one owner here.
 */
export const CLAUDE_CODE_ID = 'claude-code';
export const CLAUDE_CODE_TITLE = 'Claude Code';
export const CLAUDE_CODE_SHORT_TITLE = 'Claude';
