import type { WebSocketPlugin, WebSocketServiceCore } from '../types';
import type { Agent, Session } from '../../../types';

type AgentsChangeCallback = (agents: Agent[]) => void;
type SessionsChangeCallback = (sessions: Session[]) => void;
type CommandsChangeCallback = () => void;
type TerminalOutputCallback = (data: string) => void;
type TerminalResizeCallback = (cols: number, rows: number) => void;

/**
 * Decode base64-encoded terminal data from relay mode.
 * Relay mode wraps raw bytes in base64; P2P mode sends plain strings.
 */
export function decodeTerminalData(rawData: string): string {
  if (!rawData) {
    return rawData;
  }
  try {
    const binary = atob(rawData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
    return new TextDecoder().decode(bytes);
  } catch {
    return rawData;
  }
}

function getSessionId(payload: Record<string, unknown>): string {
  return (payload.session_name ?? payload.session_id) as string;
}

export class EventPlugin implements WebSocketPlugin {
  name = 'events';

  private agentsChangeCallbacks: AgentsChangeCallback[] = [];
  private sessionsChangeCallbacks: SessionsChangeCallback[] = [];
  private commandsChangeCallbacks: CommandsChangeCallback[] = [];
  private terminalOutputCallbacks = new Map<string, TerminalOutputCallback[]>();
  private terminalResizeCallbacks = new Map<string, TerminalResizeCallback[]>();

  install(core: WebSocketServiceCore) {
    core.onMessage('client.agents.list.response', (payload) => {
      const p = payload as Record<string, unknown>;
      if (p.agents) {
        this.notifyAgentsChange(p.agents as Agent[]);
      }
    });

    core.onMessage('client.sessions.list.response', (payload) => {
      const p = payload as Record<string, unknown>;
      if (p.sessions) {
        this.notifySessionsChange(p.sessions as Session[]);
      }
    });

    core.onMessage('terminal.output', (payload) => {
      this.handleTerminalOutput(payload as Record<string, unknown>);
    });

    core.onMessage('terminal.resize', (payload) => {
      this.handleTerminalResize(payload as Record<string, unknown>);
    });

    core.onMessage('agents.changed', (payload) => {
      const p = payload as Record<string, unknown>;
      if (p.agents) {
        this.notifyAgentsChange(p.agents as Agent[]);
      }
    });

    core.onMessage('sessions.changed', (payload) => {
      const p = payload as Record<string, unknown>;
      if (p.sessions) {
        this.notifySessionsChange(p.sessions as Session[]);
      }
    });

    core.onMessage('server.commands.changed', () => {
      this.notifyCommandsChange();
    });
  }

  onAgentsChanged(callback: AgentsChangeCallback): () => void {
    return EventPlugin.addCallback(this.agentsChangeCallbacks, callback);
  }

  onSessionsChanged(callback: SessionsChangeCallback): () => void {
    return EventPlugin.addCallback(this.sessionsChangeCallbacks, callback);
  }

  onCommandsChanged(callback: CommandsChangeCallback): () => void {
    return EventPlugin.addCallback(this.commandsChangeCallbacks, callback);
  }

  onTerminalOutput(sessionId: string, callback: TerminalOutputCallback): () => void {
    return EventPlugin.addMapCallback(this.terminalOutputCallbacks, sessionId, callback);
  }

  onTerminalResize(sessionId: string, callback: TerminalResizeCallback): () => void {
    return EventPlugin.addMapCallback(this.terminalResizeCallbacks, sessionId, callback);
  }

  private static addCallback<T>(list: T[], callback: T): () => void {
    list.push(callback);
    return () => {
      const index = list.indexOf(callback);
      if (index > -1) {
        list.splice(index, 1);
      }
    };
  }

  private static addMapCallback<T>(map: Map<string, T[]>, key: string, callback: T): () => void {
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(callback);

    return () => {
      const callbacks = map.get(key);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
        if (callbacks.length === 0) {
          map.delete(key);
        }
      }
    };
  }

  private notifyAgentsChange(agents: Agent[]): void {
    this.agentsChangeCallbacks.forEach((callback) => callback(agents));
  }

  private notifySessionsChange(sessions: Session[]): void {
    this.sessionsChangeCallbacks.forEach((callback) => callback(sessions));
  }

  private notifyCommandsChange(): void {
    this.commandsChangeCallbacks.forEach((callback) => callback());
  }

  private handleTerminalOutput(payload: Record<string, unknown>): void {
    const sessionId = getSessionId(payload);
    const rawData = (payload.data ?? '') as string;

    // Relay mode wraps data in base64; P2P sends plain strings.
    const isRelay = typeof payload.session_name === 'string' && typeof payload.session_id !== 'string';
    let data: string;
    if (isRelay) {
      data = decodeTerminalData(rawData);
    } else {
      data = rawData;
    }

    const callbacks = this.terminalOutputCallbacks.get(sessionId);
    if (callbacks) {
      callbacks.forEach((callback) => callback(data));
    }
  }

  private handleTerminalResize(payload: Record<string, unknown>): void {
    const sessionId = getSessionId(payload);
    const cols = (payload.cols as number) ?? 0;
    const rows = (payload.rows as number) ?? 0;

    const callbacks = this.terminalResizeCallbacks.get(sessionId);
    if (callbacks) {
      callbacks.forEach((callback) => callback(cols, rows));
    }
  }
}
