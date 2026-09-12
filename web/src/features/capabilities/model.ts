export type CapabilityId = string;

export type CapabilityState = 'unavailable' | 'available' | 'relevant' | 'active';

export type CapabilitySurface = 'workspace' | 'session' | 'capsule' | 'detail';

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

export interface CapabilitySummary {
  label: string;
  detail?: string;
}

/**
 * Semantic action metadata only. Execution is deliberately kept outside the
 * capability model so providers do not become coupled to React handlers or a
 * transport-specific command protocol.
 */
export interface CapabilityAction {
  id: string;
  label: string;
  description?: string;
}

/** A semantic deeper-view descriptor. Surface placement remains Nession-owned. */
export interface CapabilityView {
  id: string;
  label: string;
  description?: string;
}

export interface CapabilitySnapshot {
  id: CapabilityId;
  title: string;
  scope: CapabilityScope;
  state: CapabilityState;
  summary?: CapabilitySummary;
  actions?: readonly CapabilityAction[];
  views?: readonly CapabilityView[];
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
