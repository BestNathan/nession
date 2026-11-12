import type { CapabilityId, CapabilityState } from '@/product/capability';
import type { FocusedProject } from '@/product/project/types';

/** The contextual Project capability's stable id and identity. */
export const PROJECT_CAPABILITY_ID = 'project';
export const PROJECT_CAPABILITY_TITLE = 'Project';

/**
 * Resolve the Project capability's state from the focused Session's explicit
 * membership (#3082 SC-04).
 *
 * Only a bound Session gives Project presence; an unbound Session shows no
 * Project projection. A bound Project that is loading or ready is `relevant`
 * (`active` while its Peek/Workspace is open); a missing/unauthorized Project
 * is `unavailable` so no stale data is disclosed. Agent health is deliberately
 * absent: an offline Agent does not erase Project context.
 */
export function resolveProjectCapabilityState(
  focusedProject: FocusedProject | undefined,
  activeCapabilityId: CapabilityId | undefined,
): CapabilityState {
  if (!focusedProject) {
    return 'unavailable';
  }
  if (focusedProject.status === 'unbound' || focusedProject.status === 'unavailable') {
    return 'unavailable';
  }
  return activeCapabilityId === PROJECT_CAPABILITY_ID ? 'active' : 'relevant';
}
