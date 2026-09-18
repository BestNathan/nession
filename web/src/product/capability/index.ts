export type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityFacts,
  CapabilityId,
  CapabilityScope,
  CapabilitySnapshot,
  CapabilitySnapshotData,
  CapabilityState,
  CapabilitySurface,
} from './model';
export {
  CapabilityRegistry,
  type CapabilityResolution,
  type CapabilityResolutionDiagnostic,
} from './registry';
export {
  resolveCapabilityPresence,
  resolveCapabilityPresences,
  type CapabilityPresence,
  type CapabilityPresenceLevel,
  type PresenceContext,
} from './presence';
export {
  resolveCapabilityDisclosure,
  type CapabilityDisclosure,
  type CapabilityDisclosureEntry,
  type CapabilityDisclosureOptions,
} from './discovery';
export { MAX_OBSERVED_COMMANDS, observeSessionCommand } from './facts';
