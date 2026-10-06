/**
 * Trailing scroll clearance for the Workspace's Capsule Zone (#1347 SC-12).
 *
 * The Terminal's half of SC-12 is one owner and one consumer: `useCapsuleDockClearance`
 * measures the shell against the capsule host, publishes `--terminal-capsule-occlusion`,
 * and `TerminalViewport` spends it as `padding-bottom` — so the live bottom of the
 * terminal always sits above whatever the capsule actually occupies.
 *
 * The Workspace had no such owner. Its tool bar is an absolute overlay (SC-11,
 * correctly — the zone must not reserve permanent layout space), so a scroll
 * container's final row could end underneath the floating controls and stay
 * there, and nothing measured how much "underneath" was. `WorkspaceShell` now
 * measures it once per shell and publishes {@link WORKSPACE_CONTENT_BOTTOM_INSET}
 * — the vertical band the floating controls really occupy, zero when none are
 * drawn. A scroll container that can reach the pane bottom opts in with
 * {@link workspaceScrollClearanceClass} and its last content becomes scrollable
 * above the real occlusion, whatever the capsule happens to be showing.
 *
 * ## Why this is in `shared/` and not with the rest of the capsule's styles
 *
 * The consumers are capability components (Files, Git, Env, Claude Code), and
 * `nession/no-reverse-imports` lets a capability import only from `platform`
 * and `shared`. The host-owned primitive a capability cannot import from
 * `product/` is the same placement constraint `peekActionClass` documents; this
 * file is where the clearance half of it lands.
 *
 * One variable rather than one per capability: two scroll containers that both
 * reach the pane bottom clear the same measured band, so a fifth capability
 * cannot invent its own clearance.
 */

/**
 * Published by `useWorkspaceCapsuleClearance` on the Workspace shell; consumed
 * as trailing padding by every scroll container that reaches the pane bottom.
 *
 * The name is the terminal's consumed vocabulary (`--terminal-content-bottom-inset`)
 * with the surface that owns it swapped in, so the two halves of SC-12 read as
 * one mechanism.
 */
export const WORKSPACE_CONTENT_BOTTOM_INSET = '--nession-local-workspace-content-bottom-inset';

/**
 * The opt-in for a scroll container that can reach the pane bottom: trailing
 * padding equal to the measured Capsule Zone occlusion.
 *
 * A fallback of `0px` is not a default but the dormant case — no bar is drawn
 * (no capabilities, or nothing to navigate), the shell publishes `0px`, and the
 * container goes back to full height without reserving anything permanently.
 */
export const workspaceScrollClearanceClass =
  'pb-[var(--nession-local-workspace-content-bottom-inset,0px)]';
