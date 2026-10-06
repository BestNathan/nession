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
  /**
   * Which experience is asking (#1347 SC-37).
   *
   * Some capabilities are context-sensed rather than work-sensed: Terminal Keys
   * exists because a touch device with an active Terminal has no physical keys
   * — a fact about the *device*, not about the session's pane. That is why it
   * arrives here, beside `surface`, rather than through `facts`: facts are
   * observations of the session, and this one observes the surface the user is
   * holding.
   */
  experience?: 'web' | 'app';
  facts?: CapabilityFacts;
}

export interface CapabilitySnapshot {
  id: CapabilityId;
  /** Full human-readable capability identity. */
  title: string;
  /** Capability-owned compact identity for constrained navigation surfaces. */
  shortTitle?: string;
  scope: CapabilityScope;
  state: CapabilityState;
}

export type CapabilitySnapshotData = Omit<
  CapabilitySnapshot,
  'id' | 'title' | 'shortTitle'
>;

/**
 * A provider describes capability semantics and state. It does not own global
 * navigation, ordering, chrome, accent, or shell placement.
 */
export interface CapabilityDefinition {
  id: CapabilityId;
  /** Full human-readable capability identity. */
  title: string;
  /**
   * Capability-owned compact identity.
   *
   * Required by the registry when `title` exceeds the compact-name limit.
   * Nession never manufactures an abbreviation from the full title.
   */
  shortTitle?: string;
  resolve(context: CapabilityContext): CapabilitySnapshotData;
}
