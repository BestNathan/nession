import { getOrCreateClientId } from '@/platform/socket/clientId';
import type { PluginSurface } from '@/platform/socket/types';
import { readControlChanged } from './controlPayload';
import type { TerminalControlRole, TerminalControlState } from './state/terminalControl';

const TERMINAL_CONTROL_CHANGED_WIRE = 'agent.terminal.control.changed';

export interface AgentControlLease {
  setControl(sessionName: string, next: TerminalControlState): void;
  getControlState(sessionName: string): TerminalControlState;
  generationFor(sessionName: string): number | undefined;
  onControlChanged(
    cb: (sessionName: string, state: TerminalControlState) => void,
  ): () => void;
  roleForClient(controllerClientId?: string): TerminalControlRole;
}

/**
 * The one place the lease's role rule lives: a client is the controller only
 * when it is the holder. Every route (P2P Agent surface, Relay Server
 * surface) derives the role from the same level, so the two cannot disagree.
 */
export function controlRoleFor(
  controllerClientId: string | undefined,
  self: string,
): TerminalControlRole {
  return controllerClientId === self ? 'controller' : 'observer';
}

export function createAgentControlLease(surface: PluginSurface): AgentControlLease {
  const controlBySession = new Map<string, TerminalControlState>();
  const controlListeners = new Set<(sessionName: string, state: TerminalControlState) => void>();

  const setControl = (sessionName: string, next: TerminalControlState) => {
    controlBySession.set(sessionName, next);
    for (const listener of controlListeners) {
      listener(sessionName, next);
    }
  };

  const roleForClient = (controllerClientId?: string): TerminalControlRole =>
    controlRoleFor(controllerClientId, getOrCreateClientId());

  surface.subscribe(TERMINAL_CONTROL_CHANGED_WIRE, (payload) => {
    const changed = readControlChanged(payload);
    if (!changed) {
      return;
    }
    setControl(changed.sessionName, {
      role: roleForClient(changed.controllerClientId),
      generation: changed.generation,
      controllerClientId: changed.controllerClientId,
    });
  });

  return {
    setControl,
    getControlState: (sessionName) =>
      controlBySession.get(sessionName) ?? { role: 'controller' },
    generationFor: (sessionName) => controlBySession.get(sessionName)?.generation,
    onControlChanged: (cb) => {
      controlListeners.add(cb);
      return () => {
        controlListeners.delete(cb);
      };
    },
    roleForClient,
  };
}
