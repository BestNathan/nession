/**
 * Shared Capsule Zone — the transparent bottom area where capsule controls live.
 *
 * Capsule V2 (#1347): Terminal and Workspace share the same conceptual bottom
 * Capsule Zone. The zone itself is transparent (no background); only the capsule
 * surfaces paint background/elevation. Content may continue behind the zone;
 * pointer events are on the capsule surfaces only.
 *
 * **Success Criteria:**
 * - SC-09: Same conceptual bottom Capsule Zone on Terminal and Workspace
 * - SC-10: Zone background is transparent
 * - SC-11: Content may visually continue behind the Capsule Zone
 * - SC-12: Final content can always scroll above actual Capsule occlusion
 *
 * **Implementation:**
 * The zone is a transparent overlay at the bottom of the surface. It uses
 * `pointer-events-none` so content underneath remains interactive. The capsule
 * controls inside the zone use `pointer-events-auto` to capture events.
 *
 * Content scrolling above occlusion (SC-12) is handled by the surface's own
 * padding/margin — the zone does not clip content; it floats above it.
 */
import { cn } from '@/shared/lib/utils';
import {
  capsuleShellAppDockBottomClass,
  capsuleShellInnerPadClass,
} from '@/product/terminal/capsule/capsuleStyles';

const capsuleZoneBaseClass =
  'pointer-events-none absolute z-10 flex items-center justify-center';

/**
 * Shared capsule zone styling — transparent bottom overlay for capsule controls.
 *
 * This class can be applied to a container that holds capsule controls. It
 * establishes the transparent zone concept shared by Terminal and Workspace.
 */
export const capsuleZoneClass = cn(
  capsuleZoneBaseClass,
  'inset-x-0',
  // Bottom position uses shell-space token for consistency with capsule margins.
  // The zone floats above the content; content can scroll underneath (SC-11).
  'bottom-[var(--nession-shell-space-3)]',
  // Horizontal padding uses the capsule's own shell padding token for alignment.
  capsuleShellInnerPadClass,
);

/**
 * The App's variant of the zone (#1347 SC-08 / SC-29).
 *
 * On App the Workspace's capability form is one state of the *same* Capsule as
 * the Conversation form, so its zone must land where that capsule's dock does —
 * the App dock placement (`max(shell-inset, safe-area)`) at the App dock's own
 * horizontal inset — rather than at the Web zone's `shell-space-3` offset. That
 * placement is what makes a surface switch read as the same object in two
 * configurations instead of two different components.
 */
export const capsuleZoneAppClass = cn(
  capsuleZoneBaseClass,
  'inset-x-[length:var(--nession-terminal-capsule-shell-inset)]',
  capsuleShellAppDockBottomClass,
);
