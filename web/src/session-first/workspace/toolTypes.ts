import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { DomainState } from '@/session-first/domainState';
import type { FileOps } from '@/services/fileOps';
import type { Agent, Session } from '@/types';

export type WorkspaceToolId = 'files' | 'session' | 'agent';
export type Experience = 'web' | 'app';

/** Everything a tool layout needs from the workspace framework. */
export interface WorkspaceContext {
  session: Session | null;
  agent: Agent | undefined;
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
