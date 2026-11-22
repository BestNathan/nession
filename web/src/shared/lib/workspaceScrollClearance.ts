/**
 * Trailing scroll clearance for the Workspace's Capsule Zone (#1347 SC-12).
 *
 * #4115 strengthens the ownership of this mechanism. Before it, the Workspace
 * published one measured band and every scroll container that could reach the
 * pane bottom *opted in* by spending it as trailing padding. That made correct
 * scrolling a capability's responsibility: a new view that forgot the class had
 * its last row under the floating Capsule, a view that wanted a different
 * bottom bar had to compute the geometry itself, and two declarations on one
 * element (`pb-safe` plus the clearance class) silently composed instead of
 * one owner deciding.
 *
 * The contract is now:
 *
 * - the App Workspace host owns the **default page scroll owner** (see
 *   `AppWorkspaceScrollRegion` in `workspaceLayout.tsx`), and spends the
 *   measured inset itself;
 * - a capability view that genuinely owns an internal/fill scroll surface
 *   (a virtualized list, a diff reader, a transcript, an editor) is declared
 *   `appScroll: 'bounded'` on its binding and renders that owner through
 *   `WorkspaceBoundedScrollport` (#4222). The recipe keeps
 *   {@link workspaceBoundedScrollClearanceClass} on the **viewport**, separate
 *   from the caller's content spacing, so `p-2`/`pb-6` cannot override the
 *   measured bottom inset;
 * - neither kind computes a Capsule value. The value is measured by
 *   `useWorkspaceCapsuleClearance`; every marked bounded owner is measured from
 *   its own visible bottom (#4222 SC-02), so split readers at different
 *   coordinates each get their own inset.
 *
 * ## The three published values
 *
 * {@link WORKSPACE_SCROLL_BOTTOM_INSET} is measured from the actual scrolling
 * viewport's bottom to the floating bar's top and clamped at zero. It is the
 * honest trailing extent: when a Host-owned Bottom Actions slot sits below the
 * scrollport, the scrollport already ends above the Capsule, so this value is
 * `0` and no blank tail is created.
 *
 * {@link WORKSPACE_CONTENT_BOTTOM_INSET} is the whole floating band from the
 * shell's bottom, including the bar's own safe-area offset. It is the value the
 * Host-owned actions slot spends as its bottom padding, so the actions sit
 * above the Capsule at every overlay height.
 *
 * {@link WORKSPACE_ACTIONS_BOTTOM_INSET} names that same band explicitly for the
 * actions slot; keeping it a separate published name means the slot does not
 * have to know which element the band was derived from.
 *
 * Safe area is included exactly once because the bar is positioned with
 * `max(shell-inset, safe-area)`: its top already sits above that offset, so the
 * measured band contains it. A missing bar falls back to the App viewport
 * snapshot's safe-area bottom rather than adding `env()` a second time.
 *
 * ## Why this is in `shared/` and not with the rest of the capsule's styles
 *
 * The consumers are capability components (Files, Git, Env, Claude Code), and
 * `nession/no-reverse-imports` lets a capability import only from `platform`
 * and `shared`. The host-owned primitive a capability cannot import from
 * `product/` is the same placement constraint `peekActionClass` documents; this
 * file is where the clearance half of it lands.
 */

/**
 * Published by `useWorkspaceCapsuleClearance` on the Workspace shell; the App
 * host page scrollport spends it as trailing padding.
 *
 * The name is the terminal's consumed vocabulary (`--nession-local-terminal-content-bottom-inset`)
 * with the surface that owns it swapped in, so the two halves of SC-12 read as
 * one mechanism.
 */
export const WORKSPACE_CONTENT_BOTTOM_INSET = '--nession-local-workspace-content-bottom-inset';

/**
 * Published by `useWorkspaceCapsuleClearance` on the Workspace shell; the
 * trailing extent of the element that actually scrolls (#4115).
 *
 * A Host-owned scrollport measures from its own bottom, so an actions row below
 * it reduces the value to zero rather than leaving a reserved blank tail.
 */
export const WORKSPACE_SCROLL_BOTTOM_INSET = '--nession-local-workspace-scroll-bottom-inset';

/**
 * Published by `useWorkspaceCapsuleClearance` on the Workspace shell; the
 * bottom padding the Host-owned actions slot spends so its controls clear the
 * Capsule (#4115).
 */
export const WORKSPACE_ACTIONS_BOTTOM_INSET = '--nession-local-workspace-actions-bottom-inset';

/**
 * The opt-in for the scroll owner of a **declared bounded surface** — a
 * capability view whose binding sets `appScroll: 'bounded'` because it owns an
 * internal scroller (list, diff, transcript, editor).
 *
 * This is not the default App page scroll. A capability whose content flows
 * normally must not use it: the App host owns that scrollport
 * (`AppWorkspaceScrollRegion`) and this class would create a second one. The
 * design Gate (`layout-ownership`) rejects the retired capability-level
 * clearance and a bounded scroller that does not declare itself with
 * `data-workspace-bounded-scroll`.
 *
 * A fallback of `0px` is the dormant case: the owner has not measured yet, or
 * an element is rendered outside a Workspace shell.
 */
/**
 * The class also carries a non-styling marker class
 * (`nession-workspace-bounded-scroll`): the DOM statement that this element is
 * a declared bounded adapter, not the page scroll owner. The layout Gate reads
 * the shared constant, and browser Cases can select the marker to measure the
 * adapter's geometry. A Web-only scroller carries it too: "bounded, not the
 * page" is true in both experiences.
 */
export const WORKSPACE_BOUNDED_SCROLL_MARKER = 'nession-workspace-bounded-scroll';

export const workspaceBoundedScrollClearanceClass =
  `${WORKSPACE_BOUNDED_SCROLL_MARKER} pb-[var(--nession-local-workspace-scroll-bottom-inset,0px)]`;

/**
 * The retired per-capability clearance opt-in (#1347). Kept as a name so the
 * design Gate's negative fixture can prove a reintroduction is rejected; no
 * shipped consumer may use it.
 */
export const RETIRED_WORKSPACE_SCROLL_CLEARANCE_CLASS =
  'pb-[var(--nession-local-workspace-content-bottom-inset,0px)]';
