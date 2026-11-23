/**
 * The typed boundary between the shared MCP UI kit and whichever capability
 * hosts it (#3772).
 *
 * The kit is presentation and local view state only. Transport, process
 * launch, credentials, permissions, result bounds and persistence belong to
 * the caller's provider: #3251 supplies the current-Session-Agent user-level
 * adapter, #3600 supplies Claude's local/project adapter, and both pass the
 * authoritative Session/Agent context in.
 *
 * Nothing in this contract lets the UI start a stdio process or reach the
 * network on its own. `listServers` is the only read a view performs; probing
 * and invocation are explicit provider operations.
 */

export type McpUiExperience = 'web' | 'app';

/** The scopes a provider may expose. Which ones it supports is adapter-owned. */
export type McpScope = 'user' | 'local' | 'project';

export type McpTransport = 'http' | 'stdio' | 'sse';

/**
 * Credential *reference* state. Values never travel through this contract.
 */
export type McpCredentialState = 'bound' | 'missing' | 'not_required' | 'unknown';

export type McpClientLoadState = 'loaded' | 'not_loaded' | 'unknown';

/**
 * One configured server, as the adapter resolved it.
 *
 * `readOnly` means the kit must not offer edit/remove: the definition belongs
 * to another owner (managed, plugin, or the other capability's scope).
 */
export interface McpServerEntry {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  /** Where the definition lives — file, plugin reference or adapter label. */
  origin: string;
  /** Sanitised endpoint for HTTP transports. */
  endpoint?: string;
  /** Executable only; arguments are never echoed. */
  command?: string;
  argumentCount?: number;
  /** Names only. Values never travel. */
  envNames?: readonly string[];
  /** Names only. Values never travel. */
  headerNames?: readonly string[];
  readOnly: boolean;
  effective: boolean;
  shadowedBy?: McpScope;
  /** Another scope defines this name with a different structure. */
  conflict: boolean;
  credential: McpCredentialState;
  /** Stable non-secret identity used for optimistic conflict detection. */
  fingerprint?: string;
}

export interface McpInventory {
  state: 'ready' | 'unavailable' | 'unsupported' | 'error';
  servers: readonly McpServerEntry[];
  error?: string;
}

/**
 * Independent connection observation.
 *
 * `configured` is a declaration; this is what an explicit probe observed. The
 * kit never invents a reachable/loaded value from the config's existence.
 */
export interface McpProbeResult {
  status: 'ok' | 'refused' | 'failed' | 'unsupported';
  protocolVersion?: string;
  capabilities?: readonly string[];
  tools?: readonly McpTool[];
  /** Whether the client has loaded this server. Never inferred from a probe. */
  clientLoad?: McpClientLoadState;
  error?: string;
  detail?: string;
  truncated?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  /** The complete `inputSchema` the provider received, unmodified. */
  inputSchema: unknown;
  /** External servers may not advertise one; undefined is a sentence, not a gap. */
  outputSchema?: unknown;
  /**
   * Adapter-declared side effect. Absent means unknown, and the runner asks for
   * confirmation rather than assuming a read.
   */
  effect?: 'read' | 'write';
}

export type McpContentBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface McpCallResult {
  structuredContent?: unknown;
  content?: readonly McpContentBlock[];
  isError: boolean;
  /** The complete envelope, preserved for the Raw view. */
  raw: unknown;
}

export interface McpCallRecord {
  id: number;
  tool: string;
  status: 'success' | 'isError' | 'cancelled' | 'timeout' | 'failed' | 'confirmation_required';
  at: string;
  result?: McpCallResult;
  error?: string;
}

export interface McpServerMutation {
  action: 'create' | 'update' | 'remove';
  name: string;
  scope: McpScope;
  transport?: McpTransport;
  endpoint?: string;
  command?: string;
  argumentCount?: number;
  envNames?: readonly string[];
  headerNames?: readonly string[];
  credential?: McpCredentialState;
  /** The fingerprint the user reviewed; a changed definition is a conflict. */
  expectedFingerprint?: string;
}

export interface McpMutationResult {
  state: 'ok' | 'conflict' | 'refused' | 'error';
  message?: string;
}

export interface McpProviderCapabilities {
  /** The adapter accepts create/edit/remove in `scopes`. */
  configuration: boolean;
  /** Explicit connection probe/test is available. */
  probe: boolean;
  /** Tool discovery is available through the probe. */
  discovery: boolean;
  /** The adapter can execute an explicit `tools/call`. */
  invocation: boolean;
  /** The scopes this adapter can write. */
  scopes: readonly McpScope[];
}

export interface McpProviderContext {
  agentId: string;
  sessionId: string;
  /** The host's own label for this context, e.g. "AI" or "Claude Code". */
  hostTitle: string;
}

/**
 * The typed adapter a consuming capability supplies.
 *
 * Optional methods are genuinely optional capabilities, not unimplemented
 * stubs: the kit discloses the unsupported action instead of hiding the fact
 * that a provider exists. Implementations own all transport, authorization,
 * bounded execution, cancellation, redaction of last resort and persistence.
 */
export interface McpUiProvider {
  context: McpProviderContext;
  capabilities: McpProviderCapabilities;
  /** The only read a view performs. Must not probe or launch anything. */
  listServers(): Promise<McpInventory>;
  /** Explicit test/probe. `allowStdio` is informed consent for a stdio launch. */
  probeServer?(
    name: string,
    scope: McpScope,
    options: { allowStdio: boolean },
  ): Promise<McpProbeResult>;
  /** Explicit configuration mutation at an adapter-available scope. */
  mutateServer?(mutation: McpServerMutation): Promise<McpMutationResult>;
  /** Explicit `tools/call`, never implied by selecting or inspecting a Tool. */
  invokeTool?(
    name: string,
    scope: McpScope,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallResult>;
}
