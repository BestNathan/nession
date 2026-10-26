import { getOrCreateClientId } from '@/platform/socket/clientId';
import { getOrCreateSubscriptionId } from '@/platform/socket/subscriptionId';
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
  roleForClient(
    controllerClientId?: string,
    controllerSubscriptionId?: string,
  ): TerminalControlRole;
}

/** Who a lease names, or who is asking. */
export interface ControlIdentity {
  clientId?: string;
  subscriptionId?: string;
}

/**
 * The one place the lease's role rule lives: a subscription is the controller
 * only when it holds the lease. Every route (P2P Agent surface, Relay Server
 * surface) derives the role from the same level, so the two cannot disagree.
 *
 * The subscription is the precise identity when **both** sides state one:
 * same-origin tabs share the browser's client id, so comparing that alone
 * makes every tab believe it controls the session. An Agent that predates
 * subscription identity states none, and the client-id rule it already had is
 * what applies.
 */
export function controlRoleFor(
  controller: ControlIdentity,
  self: ControlIdentity,
): TerminalControlRole {
  if (controller.subscriptionId !== undefined && self.subscriptionId !== undefined) {
    return controller.subscriptionId === self.subscriptionId ? 'controller' : 'observer';
  }
  return controller.clientId !== undefined && controller.clientId === self.clientId
    ? 'controller'
    : 'observer';
}

function selfIdentity(): ControlIdentity {
  return {
    clientId: getOrCreateClientId(),
    subscriptionId: getOrCreateSubscriptionId(),
  };
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

  const roleForClient = (
    controllerClientId?: string,
    controllerSubscriptionId?: string,
  ): TerminalControlRole =>
    controlRoleFor(
      { clientId: controllerClientId, subscriptionId: controllerSubscriptionId },
      selfIdentity(),
    );

  surface.subscribe(TERMINAL_CONTROL_CHANGED_WIRE, (payload) => {
    const changed = readControlChanged(payload);
    if (!changed) {
      return;
    }
    setControl(changed.sessionName, {
      role: roleForClient(changed.controllerClientId, changed.controllerSubscriptionId),
      generation: changed.generation,
      controllerClientId: changed.controllerClientId,
      controllerSubscriptionId: changed.controllerSubscriptionId,
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
