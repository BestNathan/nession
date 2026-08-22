/**
 * WebSocketService — facade that delegates to plugins.
 *
 * Creates a {@link WebSocketServiceCoreImpl} and installs three plugins:
 * - EventPlugin (event subscriptions: agents, sessions, commands, terminal)
 * - RequestPlugin (request/response: listAgents, createSession, env, etc.)
 * - TerminalPlugin (fire-and-forget terminal I/O and relay lifecycle)
 *
 * All public methods match the original monolithic WebSocketService API
 * to maintain full backward compatibility.
 */

import type {
  ConnectionStatus,
  Agent,
  Session,
  AttachInfo,
  CreateSessionResponse,
  KillSessionResponse,
  EnvFileRef,
  EnvListResponse,
  EnvGetResponse,
  EnvWriteResponse,
  EnvDeleteResponse,
  SessionEnvResponse,
  SessionEnvActiveResponse,
  SessionEnvQueryResponse,
  ServerInfo,
  SessionsListResponse,
  CommandsListResponse,
  CommandsAddResponse,
  CommandsRemoveResponse,
  CommandsUpdateResponse,
} from '../../types';
import { WebSocketServiceCoreImpl } from './core';
import { EventPlugin } from './plugins/EventPlugin';
import { RequestPlugin } from './plugins/RequestPlugin';
import { TerminalPlugin } from './plugins/TerminalPlugin';

type ConnectionChangeCallback = (status: ConnectionStatus) => void;
type AgentsChangeCallback = (agents: Agent[]) => void;
type SessionsChangeCallback = (sessions: Session[]) => void;
type CommandsChangeCallback = () => void;
type TerminalOutputCallback = (data: Uint8Array) => void;
type TerminalResizeCallback = (cols: number, rows: number) => void;

export class WebSocketService {
  private readonly core: WebSocketServiceCoreImpl;
  private readonly events: EventPlugin;
  private readonly requests: RequestPlugin;
  private readonly terminal: TerminalPlugin;

  constructor(url: string, authToken: string) {
    this.core = new WebSocketServiceCoreImpl(url, authToken);

    this.events = new EventPlugin();
    this.requests = new RequestPlugin();
    this.terminal = new TerminalPlugin();

    this.events.install(this.core);
    this.requests.install(this.core);
    this.terminal.install(this.core);
  }

  // ── Connection Management (delegated to core) ─────────────────

  async connect(): Promise<void> {
    return this.core.connect();
  }

  disconnect(): void {
    this.core.disconnect();
  }

  isConnected(): boolean {
    return this.core.isConnected();
  }

  /** @deprecated Use {@link isAuthenticated} (capital A). Kept for backward compat. */
  isauthenticated(): boolean {
    return this.core.isAuthenticated();
  }

  isAuthenticated(): boolean {
    return this.core.isAuthenticated();
  }

  getConnectionStatus(): ConnectionStatus {
    return this.core.getConnectionStatus();
  }

  onConnectionChange(callback: ConnectionChangeCallback): () => void {
    return this.core.onConnectionChange(callback);
  }

  async authenticate(): Promise<void> {
    return this.core.authenticate();
  }

  // ── Event Subscriptions (delegated to EventPlugin) ────────────

  onAgentsChanged(callback: AgentsChangeCallback): () => void {
    return this.events.onAgentsChanged(callback);
  }

  onSessionsChanged(callback: SessionsChangeCallback): () => void {
    return this.events.onSessionsChanged(callback);
  }

  onCommandsChanged(callback: CommandsChangeCallback): () => void {
    return this.events.onCommandsChanged(callback);
  }

  onTerminalOutput(sessionId: string, callback: TerminalOutputCallback): () => void {
    return this.events.onTerminalOutput(sessionId, callback);
  }

  onTerminalResize(sessionId: string, callback: TerminalResizeCallback): () => void {
    return this.events.onTerminalResize(sessionId, callback);
  }

  // ── Request/Response API (delegated to RequestPlugin) ─────────

  async listAgents(): Promise<Agent[]> {
    return this.requests.listAgents();
  }

  async serverInfo(): Promise<ServerInfo> {
    return this.requests.serverInfo();
  }

  /** Capture tmux scrollback as decoded UTF-8 ANSI text with optional dimensions. */
  async capturePreview(
    sessionId: string,
    lines: number,
  ): Promise<{ ansi: string; cols?: number; rows?: number }> {
    return this.requests.capturePreview(sessionId, lines);
  }

  async listSessions(agentId?: string): Promise<Session[]> {
    return this.requests.listSessions(agentId);
  }

  /** Fetch sessions with the full response (including `stale_agents`).
   *  Pass `force: true` to make the server re-query every online agent. */
  async fetchSessions(
    opts: { agentId?: string; force?: boolean } = {},
  ): Promise<SessionsListResponse> {
    return this.requests.fetchSessions(opts);
  }

  async requestAttach(
    sessionId: string,
    mode: 'p2p' | 'relay' = 'p2p',
    relayUrl?: string,
  ): Promise<AttachInfo> {
    return this.requests.requestAttach(sessionId, mode, relayUrl);
  }

  async createSession(
    agentId: string,
    name: string,
    envFiles: EnvFileRef[] = [],
  ): Promise<CreateSessionResponse> {
    return this.requests.createSession(agentId, name, envFiles);
  }

  async killSession(sessionId: string): Promise<KillSessionResponse> {
    return this.requests.killSession(sessionId);
  }

  async renameAgent(agentId: string, displayName: string | null): Promise<Agent> {
    return this.requests.renameAgent(agentId, displayName);
  }

  async deleteAgent(agentId: string): Promise<void> {
    return this.requests.deleteAgent(agentId);
  }

  // ── Environment-variable file management (delegated to RequestPlugin) ──

  async listEnvFiles(): Promise<EnvListResponse> {
    return this.requests.listEnvFiles();
  }

  async getEnvFile(ref: EnvFileRef): Promise<EnvGetResponse> {
    return this.requests.getEnvFile(ref);
  }

  async writeEnvFile(
    ref: EnvFileRef,
    content: string,
    overwrite: boolean,
    force = false,
  ): Promise<EnvWriteResponse> {
    return this.requests.writeEnvFile(ref, content, overwrite, force);
  }

  async deleteEnvFile(ref: EnvFileRef): Promise<EnvDeleteResponse> {
    return this.requests.deleteEnvFile(ref);
  }

  async applySessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[],
  ): Promise<SessionEnvResponse> {
    return this.requests.applySessionEnv(sessionId, envFiles);
  }

  async unsetSessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[],
  ): Promise<SessionEnvResponse> {
    return this.requests.unsetSessionEnv(sessionId, envFiles);
  }

  async getSessionEnvActive(sessionId: string): Promise<SessionEnvActiveResponse> {
    return this.requests.getSessionEnvActive(sessionId);
  }

  async queryAgentEnvState(sessionId: string): Promise<SessionEnvQueryResponse> {
    return this.requests.queryAgentEnvState(sessionId);
  }

  // ── Claude Code Extension (delegated to RequestPlugin) ────────

  async claudeCodeList(req: {
    agent_id: string;
    scope: 'global' | 'project';
    session_id?: string;
  }): Promise<{ available: boolean; categories: { name: string; icon: string | null; files: { path: string; size: number; content_type: string }[] }[]; error?: string }> {
    return this.requests.claudeCodeList(req);
  }

  async claudeCodeRead(req: {
    agent_id: string;
    scope: 'global' | 'project';
    session_id?: string;
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<{ content: string; content_type: string; total_size: number; offset: number; has_more: boolean; error?: string }> {
    return this.requests.claudeCodeRead(req);
  }

  // ── Quick Commands (delegated to RequestPlugin) ───────────────

  async listCommands(): Promise<CommandsListResponse> {
    return this.requests.listCommands();
  }

  async addCommand(
    label: string,
    command: string,
    raw = false,
  ): Promise<CommandsAddResponse> {
    return this.requests.addCommand(label, command, raw);
  }

  async removeCommand(id: string): Promise<CommandsRemoveResponse> {
    return this.requests.removeCommand(id);
  }

  async updateCommand(
    id: string,
    fields: { label?: string; command?: string; raw?: boolean },
  ): Promise<CommandsUpdateResponse> {
    return this.requests.updateCommand(id, fields);
  }

  // ── Terminal I/O (delegated to TerminalPlugin) ────────────────

  sendTerminalInput(sessionId: string, data: string): void {
    this.terminal.sendTerminalInput(sessionId, data);
  }

  sendTerminalResize(sessionId: string, cols: number, rows: number): void {
    this.terminal.sendTerminalResize(sessionId, cols, rows);
  }

  // ── Relay lifecycle (delegated to TerminalPlugin) ─────────────

  beginRelay(sessionId: string, relayUrl?: string, cols?: number, rows?: number): void {
    this.terminal.beginRelay(sessionId, relayUrl, cols, rows);
  }

  endRelay(sessionId: string): void {
    this.terminal.endRelay(sessionId);
  }

  // ── Relay terminal I/O (delegated to TerminalPlugin) ──────────

  sendRelayInput(sessionName: string, data: string): void {
    this.terminal.sendRelayInput(sessionName, data);
  }

  sendRelayResize(sessionName: string, cols: number, rows: number): void {
    this.terminal.sendRelayResize(sessionName, cols, rows);
  }

  // ── P2P Support (delegated to core) ──────────────────────────

  getP2PConnectionInfo(attachInfo: AttachInfo): { url: string; token: string } | null {
    return this.core.getP2PConnectionInfo(attachInfo);
  }

  // ── Backward-compatible accessors for internal state ──────────
  //
  // These getter/setter pairs delegate to the core so that tests
  // that cast `as unknown as { reconnectAttempts: number }` continue
  // to work through the facade.

  get reconnectAttempts(): number {
    return (this.core as unknown as { reconnectAttempts: number }).reconnectAttempts;
  }

  set reconnectAttempts(value: number) {
    (this.core as unknown as { reconnectAttempts: number }).reconnectAttempts = value;
  }

  get reconnectTimer(): ReturnType<typeof setTimeout> | null {
    return (this.core as unknown as { reconnectTimer: ReturnType<typeof setTimeout> | null }).reconnectTimer;
  }

  set reconnectTimer(value: ReturnType<typeof setTimeout> | null) {
    (this.core as unknown as { reconnectTimer: ReturnType<typeof setTimeout> | null }).reconnectTimer = value;
  }
}
