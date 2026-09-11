export type {
  CapabilityAction,
  CapabilityContext,
  CapabilityDefinition,
  CapabilityId,
  CapabilityScope,
  CapabilitySnapshot,
  CapabilitySnapshotData,
  CapabilityState,
  CapabilitySummary,
  CapabilitySurface,
  CapabilityView,
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
