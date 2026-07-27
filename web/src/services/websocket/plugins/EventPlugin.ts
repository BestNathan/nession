import type { WebSocketPlugin, WebSocketServiceCore } from '../types';
import type { Agent, Session } from '../../../types';

type AgentsChangeCallback = (agents: Agent[]) => void;
type SessionsChangeCallback = (sessions: Session[]) => void;
type CommandsChangeCallback = () => void;
type TerminalOutputCallback = (data: string) => void;
type TerminalResizeCallback = (cols: number, rows: number) => void;

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
    this.agentsChangeCallbacks.push(callback);
    return () => {
      const index = this.agentsChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.agentsChangeCallbacks.splice(index, 1);
      }
    };
  }

  onSessionsChanged(callback: SessionsChangeCallback): () => void {
    this.sessionsChangeCallbacks.push(callback);
    return () => {
      const index = this.sessionsChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.sessionsChangeCallbacks.splice(index, 1);
      }
    };
  }

  onCommandsChanged(callback: CommandsChangeCallback): () => void {
    this.commandsChangeCallbacks.push(callback);
    return () => {
      const index = this.commandsChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.commandsChangeCallbacks.splice(index, 1);
      }
    };
  }

  onTerminalOutput(sessionId: string, callback: TerminalOutputCallback): () => void {
    if (!this.terminalOutputCallbacks.has(sessionId)) {
      this.terminalOutputCallbacks.set(sessionId, []);
    }
    this.terminalOutputCallbacks.get(sessionId)!.push(callback);

    return () => {
      const callbacks = this.terminalOutputCallbacks.get(sessionId);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
        if (callbacks.length === 0) {
          this.terminalOutputCallbacks.delete(sessionId);
        }
      }
    };
  }

  onTerminalResize(sessionId: string, callback: TerminalResizeCallback): () => void {
    if (!this.terminalResizeCallbacks.has(sessionId)) {
      this.terminalResizeCallbacks.set(sessionId, []);
    }
    this.terminalResizeCallbacks.get(sessionId)!.push(callback);

    return () => {
      const callbacks = this.terminalResizeCallbacks.get(sessionId);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
        if (callbacks.length === 0) {
          this.terminalResizeCallbacks.delete(sessionId);
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
    const sessionId = (payload.session_name ?? payload.session_id) as string;
    const rawData = (payload.data ?? '') as string;

    const isRelay = typeof payload.session_name === 'string' && typeof payload.session_id !== 'string';
    let data: string;
    if (isRelay && rawData) {
      try {
        const binary = atob(rawData);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
        data = new TextDecoder().decode(bytes);
      } catch {
        data = rawData;
      }
    } else {
      data = rawData;
    }

    const callbacks = this.terminalOutputCallbacks.get(sessionId);
    if (callbacks) {
      callbacks.forEach((callback) => callback(data));
    }
  }

  private handleTerminalResize(payload: Record<string, unknown>): void {
    const sessionId = (payload.session_name ?? payload.session_id) as string;
    const cols = payload.cols as number;
    const rows = payload.rows as number;

    const callbacks = this.terminalResizeCallbacks.get(sessionId);
    if (callbacks) {
      callbacks.forEach((callback) => callback(cols, rows));
    }
  }
}
