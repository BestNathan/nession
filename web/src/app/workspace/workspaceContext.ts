import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { CapabilityFacts, CapabilityId } from '@/features/capabilities';
import type { CapsuleExperience } from '@/features/terminal/capsule/types';
import type { DomainState } from '@/features/sessions/model/domainState';
import type { FileOps } from '@/features/files';
import type { Agent, Session } from '@/types';

export type Experience = CapsuleExperience;

/** Everything a Workspace view layout needs from the workspace framework. */
export interface WorkspaceContext {
  session: Session | null;
  agent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  fileOps: FileOps | null;
  experience: Experience;
  onToolChange: (id: CapabilityId) => void;
  /** Observations about the session, supplied by the app layer (never probed here). */
  facts?: CapabilityFacts;
}

/**
 * How a capability draws itself in the Workspace.
 *
 * Only the two things a view owns: the React layouts and the icon its chrome
 * shows. What the capability *is* — its title, whether it is available, whether
 * it deserves a slot — is decided by its provider in the capability layer, so a
 * binding cannot grant itself presence by existing.
 */
export interface WorkspaceViewBinding {
  id: CapabilityId;
  icon: LucideIcon;
  layout: {
    web: ComponentType<{ ctx: WorkspaceContext }>;
    app: ComponentType<{ ctx: WorkspaceContext }>;
  };
}
