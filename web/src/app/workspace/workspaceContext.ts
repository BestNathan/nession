import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { CapabilityFacts, CapabilityId } from '@/product/capability';
import type { CapsuleExperience } from '@/product/terminal/capsule/types';
import type { DomainState } from '@/product/session/model/domainState';
import type { FileOps } from '@/capabilities/files';
import type { Agent, Session } from '@/types';

export type Experience = CapsuleExperience;

/**
 * The capabilities that draw a different Workspace view per experience.
 *
 * Each experience supplies a layout for every member (`experiences/{web,app}/workspaceViews.tsx`),
 * so naming them as a union makes a missing one a compile error rather than a
 * binding that resolves to `undefined` at render. Claude Code is deliberately
 * absent: it draws the same view in both experiences, so its binding is
 * contributed whole by the capability instead.
 */
export type WorkspaceViewId = 'files' | 'session' | 'agent' | 'env';

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
