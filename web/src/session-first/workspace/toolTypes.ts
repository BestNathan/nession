import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { CapsuleExperience } from '@/session-first/capsule/types';
import type { DomainState } from '@/session-first/domainState';
import type { FileOps } from '@/features/files';
import type { Agent, Session } from '@/types';

export type WorkspaceToolId = 'files' | 'session' | 'agent' | 'claude-code' | 'env';
export type Experience = CapsuleExperience;

/** Everything a tool layout needs from the workspace framework. */
export interface WorkspaceContext {
  session: Session | null;
  agent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  fileOps: FileOps | null;
  experience: Experience;
  onToolChange: (id: WorkspaceToolId) => void;
}

/**
 * A workspace tool is a plugin: it owns its label/icon/order/availability
 * and its own layouts per experience. Adding a tool = one file + one
 * registry line; the framework does not change.
 */
export interface WorkspaceTool {
  id: WorkspaceToolId;
  label: string;
  icon: LucideIcon;
  order: number;
  availability: (ctx: WorkspaceContext) => boolean;
  layout: {
    web: ComponentType<{ ctx: WorkspaceContext }>;
    app: ComponentType<{ ctx: WorkspaceContext }>;
  };
}
