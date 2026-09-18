import type {
  CapabilityId,
  CapabilitySnapshot,
  CapabilitySurface,
} from './model';

export type CapabilityPresenceLevel =
  | 'hidden'
  | 'discoverable'
  | 'contextual'
  | 'prominent';

export interface PresenceContext {
  surface: CapabilitySurface;
}

export interface CapabilityPresence {
  capabilityId: CapabilityId;
  surface: CapabilitySurface;
  level: CapabilityPresenceLevel;
}

/**
 * Default product-level presence policy. Capability state is semantic input;
 * UI presence remains a separate Nession-owned decision.
 */
export function resolveCapabilityPresence(
  snapshot: CapabilitySnapshot,
  context: PresenceContext,
): CapabilityPresence {
  let level: CapabilityPresenceLevel;

  if (snapshot.state === 'unavailable') {
    level = 'hidden';
  } else if (snapshot.state === 'available') {
    level = 'discoverable';
  } else if (snapshot.state === 'relevant') {
    level = 'contextual';
  } else {
    // The Session interaction layer is where an active capability belongs in
    // the user's face; every other surface keeps it alongside its peers.
    level = context.surface === 'capsule' ? 'prominent' : 'contextual';
  }

  return {
    capabilityId: snapshot.id,
    surface: context.surface,
    level,
  };
}

export function resolveCapabilityPresences(
  snapshots: readonly CapabilitySnapshot[],
  context: PresenceContext,
): CapabilityPresence[] {
  return snapshots.map((snapshot) => resolveCapabilityPresence(snapshot, context));
}
