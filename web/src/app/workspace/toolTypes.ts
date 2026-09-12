import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { CapabilityFacts, CapabilityId } from '@/features/capabilities';
import type { CapsuleExperience } from '@/features/terminal/capsule/types';
import type { DomainState } from '@/features/sessions/model/domainState';
import type { FileOps } from '@/features/files';
import type { Agent, Session } from '@/types';

/**
 * Transitional alias for legacy Workspace view bindings. Capability identity is
 * intentionally open-ended; adding a capability must not require extending a
 * closed shell enum.
 */
export type WorkspaceToolId = CapabilityId;
export type Experience = CapsuleExperience;

/** Everything a legacy tool layout needs from the workspace framework. */
export interface WorkspaceContext {
  session: Session | null;
  agent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  fileOps: FileOps | null;
  experience: Experience;
  onToolChange: (id: WorkspaceToolId) => void;
  /** Observations about the session, supplied by the app layer (never probed here). */
  facts?: CapabilityFacts;
}

/**
 * Migration-time Workspace view binding.
 *
 * The binding still owns the current React layouts and visual identity needed
 * to render an existing deeper view. It no longer owns whether that capability
 * receives direct Workspace presence; that decision belongs to the shared
 * capability + Nession presentation policy.
 */
export interface WorkspaceTool {
  id: WorkspaceToolId;
  label: string;
  icon: LucideIcon;
  /** Legacy deterministic fallback order, never capability presence priority. */
  order: number;
  availability: (ctx: WorkspaceContext) => boolean;
  layout: {
    web: ComponentType<{ ctx: WorkspaceContext }>;
    app: ComponentType<{ ctx: WorkspaceContext }>;
  };
}
