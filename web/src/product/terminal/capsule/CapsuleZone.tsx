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
import { capsuleShellInnerPadClass } from '@/product/terminal/capsule/capsuleStyles';

/**
 * Shared capsule zone styling — transparent bottom overlay for capsule controls.
 *
 * This class can be applied to a container that holds capsule controls. It
 * establishes the transparent zone concept shared by Terminal and Workspace.
 */
export const capsuleZoneClass = cn(
  'pointer-events-none absolute inset-x-0 z-10 flex items-center justify-center',
  // Bottom position uses shell-space token for consistency with capsule margins.
  // The zone floats above the content; content can scroll underneath (SC-11).
  'bottom-[var(--shell-space-3)]',
  // Horizontal padding uses the capsule's own shell padding token for alignment.
  capsuleShellInnerPadClass,
);
