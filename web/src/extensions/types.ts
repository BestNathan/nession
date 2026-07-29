import type { ComponentType } from 'react';
import type { Agent } from '../types';

/** Props passed to the agent-detail slot */
export interface AgentDetailSlotProps {
  agent: Agent;
}

/** Props passed to the terminal-header slot */
export interface TerminalHeaderSlotProps {
  sessionId: string;
  sessionName: string;
}

/** An extension that renders UI in named slots */
export interface UIExtension {
  name: string;
  slots: {
    /* eslint-disable @typescript-eslint/naming-convention --
     * Slot names use kebab-case to match conventional slot naming patterns and
     * cannot be renamed to camelCase. */
    'agent-detail'?: ComponentType<AgentDetailSlotProps>;
    'terminal-header'?: ComponentType<TerminalHeaderSlotProps>;
  };
}
