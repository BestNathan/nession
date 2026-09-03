/**
 * WebSocketService — facade that delegates to registered capabilities.
 *
 * Creates a {@link WebSocketServiceCoreImpl} and registers the built-in
 * plugins through {@link use} (#593 Goal/Scope 10), so extensions can add
 * capabilities without touching the core or the facade:
 * - EventPlugin (event subscriptions: agents, sessions, commands, terminal)
 * - RequestPlugin (request/response: listAgents, createSession, env, etc.)
 * - TerminalPlugin (fire-and-forget terminal I/O and relay lifecycle)
 * - ClaudeCodePlugin (extension.claude_code list/read RPCs)
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
import { ClaudeCodePlugin, type ClaudeCodeListRequest, type ClaudeCodeListResponse, type ClaudeCodeReadRequest, type ClaudeCodeReadResponse } from './plugins/ClaudeCodePlugin';
import type { WebSocketPlugin } from './types';

type ConnectionChangeCallback = (status: ConnectionStatus) => void;
type AgentsChangeCallback = (agents: Agent[]) => void;
type SessionsChangeCallback = (sessions: Session[]) => void;
type CommandsChangeCallback = () => void;
type TerminalOutputCallback = (data: Uint8Array) => void;
type TerminalResizeCallback = (cols: number, rows: number) => void;

interface RegisteredPlugin {
  plugin: WebSocketPlugin;
  /** Teardown returned by install(), or a wrapper over the legacy uninstall?. */
  teardown: () => void;
}

export class WebSocketService {
  private readonly core: WebSocketServiceCoreImpl;
  private readonly plugins = new Map<string, RegisteredPlugin>();

  constructor(url: string, authToken: string) {
    this.core = new WebSocketServiceCoreImpl(url, authToken);

    // Built-in capabilities register through the same API extensions use.
    this.use(new EventPlugin());
    this.use(new RequestPlugin());
    this.use(new TerminalPlugin());
    this.use(new ClaudeCodePlugin());
  }

  // ── Capability registration (#593 Goal/Scope 10) ──────────────

  /**
   * Install a capability plugin. A plugin of the same name is unregistered
   * (its teardown runs) before the new one is installed.
   */
  use(plugin: WebSocketPlugin): void {
    if (!plugin.name) {
      throw new Error('WebSocketService: plugin name must not be empty');
    }
    this.unregister(plugin.name);
    const installed = plugin.install(this.core);
    // Legacy contract: when install() returns nothing, retain the plugin's
    // uninstall() as the FUTURE teardown — never invoke it during registration.
    const teardown = installed ?? (plugin.uninstall ? () => plugin.uninstall!() : undefined);
    if (!teardown) {
      throw new Error(
        `WebSocketService: plugin '${plugin.name}' must return a teardown from install() or implement uninstall()`,
      );
    }
    this.plugins.set(plugin.name, { plugin, teardown });
  }

  /** Uninstall a capability: runs its teardown and removes it. */
  unregister(name: string): boolean {
    const entry = this.plugins.get(name);
    if (!entry) {
      return false;
    }
    this.plugins.delete(name);
    entry.teardown();
    return true;
  }

  /** Access a registered capability instance (null when not registered). */
  getCapability<T>(name: string): T | null {
    return (this.plugins.get(name)?.plugin as T | undefined) ?? null;
  }

  private requirePlugin<T extends WebSocketPlugin>(name: string): T {
    const entry = this.plugins.get(name);
    if (!entry) {
      throw new Error(`WebSocketService: plugin '${name}' is not registered`);
    }
    return entry.plugin as T;
  }

  private get events(): EventPlugin {
    return this.requirePlugin<EventPlugin>('events');
  }

  private get requests(): RequestPlugin {
    return this.requirePlugin<RequestPlugin>('requests');
  }

  private get terminal(): TerminalPlugin {
    return this.requirePlugin<TerminalPlugin>('terminal');
  }

  private get claudeCode(): ClaudeCodePlugin {
    return this.requirePlugin<ClaudeCodePlugin>('claude-code');
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

  getUrl(): string {
    return this.core.getUrl();
  }

  getAuthToken(): string {
    return this.core.getAuthToken();
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

  // ── Claude Code Extension (delegated to ClaudeCodePlugin) ───────

  async claudeCodeList(req: ClaudeCodeListRequest): Promise<ClaudeCodeListResponse> {
    return this.claudeCode.claudeCodeList(req);
  }

  async claudeCodeRead(req: ClaudeCodeReadRequest): Promise<ClaudeCodeReadResponse> {
    return this.claudeCode.claudeCodeRead(req);
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
