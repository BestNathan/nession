export type CapabilityId = string;

export type CapabilityState = 'unavailable' | 'available' | 'relevant' | 'active';

/**
 * Surfaces that actually consume capability presence.
 *
 * A surface is listed here when something reads it — the Workspace presentation
 * and the Session interaction layer (the capsule) today. `session` and `detail`
 * used to sit alongside them with no consumer: the axis existed, the code that
 * would have given it meaning did not, so the model advertised presence no
 * surface could show. An unused axis is worse than a missing one — it makes an
 * absent feature look implemented. Session-level presence for an `active`
 * capability is the capsule chip, per `docs/design/product-model.md`
 * ("may surface directly in the Session interaction layer").
 *
 * Adding one back is a union member plus the code that consumes it.
 */
export type CapabilitySurface = 'workspace' | 'capsule';

export interface CapabilityScope {
  workspaceId?: string;
  locationId?: string;
  sessionId?: string;
}

/**
 * Observations about the current context, supplied by the surface that owns the
 * signal. Facts describe what was observed — never what it means: a provider
 * interprets them into capability state, so detection stays out of the core.
 */
export interface CapabilityFacts {
  /** Foreground command of the session's active pane, when the agent reports one. */
  sessionForegroundCommand?: string | null;
  /** Foreground commands observed during the current session, most recent last. */
  sessionObservedCommands?: readonly string[];
}

export interface CapabilityContext extends CapabilityScope {
  surface?: CapabilitySurface;
  facts?: CapabilityFacts;
}

export interface CapabilitySnapshot {
  id: CapabilityId;
  title: string;
  scope: CapabilityScope;
  state: CapabilityState;
}

export type CapabilitySnapshotData = Omit<CapabilitySnapshot, 'id' | 'title'>;

/**
 * A provider describes capability semantics and state. It does not own global
 * navigation, ordering, chrome, accent, or shell placement.
 */
export interface CapabilityDefinition {
  id: CapabilityId;
  title: string;
  resolve(context: CapabilityContext): CapabilitySnapshotData;
}
