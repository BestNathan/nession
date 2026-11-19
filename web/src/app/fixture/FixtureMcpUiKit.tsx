import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';

import type { WorkspaceContext, WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import {
  McpKitView,
  type McpCallResult,
  type McpInventory,
  type McpProbeResult,
  type McpScope,
  type McpServerEntry,
  type McpServerMutation,
  type McpTool,
  type McpUiProvider,
} from '@/capabilities/mcp-ui';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

type FixtureScenario = 'ready' | 'offline' | 'auth' | 'error' | 'unknown';
type FixtureHost = 'ai' | 'claude';

interface FixtureState {
  servers: McpServerEntry[];
  fingerprintNonce: number;
}

const SESSION_LIST_TOOL: McpTool = {
  name: 'session.list',
  description: 'List the current Agent’s tmux sessions.',
  effect: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['current', 'all'],
        description: 'Which Sessions to list.',
      },
      limit: { type: 'integer', minimum: 1, description: 'Maximum Sessions to return.' },
    },
    required: ['scope'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      sessions: {
        type: 'array',
        items: { type: 'object' },
        description: 'Session rows.',
      },
      next_cursor: { type: ['string', 'null'], description: 'Continuation when bounded.' },
    },
    required: ['sessions'],
  },
};

const SESSION_RENAME_TOOL: McpTool = {
  name: 'session.rename',
  description: 'Rename one Session. May modify runtime state.',
  effect: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'The Session to rename.' },
      title: { type: 'string', description: 'The new Session title.' },
    },
    required: ['session_id', 'title'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      updated: { type: 'boolean' },
      session_id: { type: 'string' },
    },
    required: ['updated', 'session_id'],
  },
};

/** An external Tool: no output schema, so the inspector must say so. */
const SEARCH_REPOSITORIES_TOOL: McpTool = {
  name: 'search_repositories',
  description: 'Search GitHub repositories. External provider; no output contract.',
  effect: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text.' },
    },
    required: ['query'],
  },
};

function scenarioOf(search: string): FixtureScenario {
  const value = new URLSearchParams(search).get('mcp');
  return value === 'offline' || value === 'auth' || value === 'error' || value === 'unknown'
    ? value
    : 'ready';
}

function hostOf(search: string): FixtureHost {
  return new URLSearchParams(search).get('mcpHost') === 'claude' ? 'claude' : 'ai';
}

function initialServers(host: FixtureHost, scenario: FixtureScenario): McpServerEntry[] {
  const scope = host === 'ai' ? 'user' : 'local';
  const origin = host === 'ai' ? '~/.config/ai/mcp.json' : '.claude/settings.local.json';
  return [
    {
      name: 'nession',
      scope,
      transport: 'http',
      origin,
      endpoint: 'https://agent.invalid/mcp',
      readOnly: false,
      effective: true,
      conflict: false,
      credential: 'bound',
      headerNames: ['Authorization'],
      fingerprint: 'fixture-nession-1',
    },
    {
      name: 'github',
      scope,
      transport: 'stdio',
      origin,
      command: 'npx',
      argumentCount: 2,
      envNames: ['GITHUB_TOKEN'],
      readOnly: false,
      effective: true,
      conflict: false,
      credential: scenario === 'auth' ? 'missing' : 'bound',
      fingerprint: 'fixture-github-1',
    },
    {
      name: 'managed-catalog',
      scope,
      transport: 'http',
      origin: 'plugin:managed-catalog',
      endpoint: 'https://catalog.invalid/mcp',
      readOnly: true,
      effective: true,
      conflict: false,
      credential: 'not_required',
    },
  ];
}

function toolsFor(serverName: string): McpTool[] {
  if (serverName === 'nession') {
    return [SESSION_LIST_TOOL, SESSION_RENAME_TOOL];
  }
  if (serverName === 'github') {
    return [SEARCH_REPOSITORIES_TOOL];
  }
  return [];
}

function callResult(serverName: string, tool: string): McpCallResult {
  const structured =
    serverName === 'github'
      ? { items: [{ name: 'BestNathan/nession' }] }
      : tool === 'session.rename'
        ? { updated: true, session_id: 'fixture-session' }
        : {
            sessions: [
              { id: 'fixture-session', state: 'active', unknown_field: { preserved: true } },
            ],
            next_cursor: null,
          };
  return {
    structuredContent: structured,
    content: [
      { type: 'text', text: `Fixture ${tool} completed.` },
      { type: 'fixture_unknown', value: 42 },
    ],
    isError: false,
    raw: {
      content: [{ type: 'text', text: `Fixture ${tool} completed.` }],
      structuredContent: structured,
      _meta: {
        provider: 'fixture',
        authorization: 'Bearer fixture-secret-token',
        unknownField: { preserved: true },
      },
    },
  };
}

function listFixture(state: FixtureState, scenario: FixtureScenario): McpInventory {
  if (scenario === 'offline') {
    return {
      state: 'unavailable',
      servers: [],
      error: 'Current Session Agent is offline; the inventory is unavailable.',
    };
  }
  return { state: 'ready', servers: state.servers };
}

function probeFixture(
  state: FixtureState,
  name: string,
  options: { allowStdio: boolean },
  scenario: FixtureScenario,
): McpProbeResult {
  const server = state.servers.find((entry) => entry.name === name);
  if (!server) {
    return { status: 'failed', error: 'Server not found in this fixture.' };
  }
  if (scenario === 'offline') {
    return { status: 'failed', error: 'Session Agent offline.' };
  }
  if (server.credential === 'missing') {
    return {
      status: 'refused',
      error: 'Credential binding is missing; the probe was not attempted.',
    };
  }
  if (server.transport === 'stdio' && !options.allowStdio) {
    return {
      status: 'refused',
      error: 'A stdio probe needs explicit consent before launching a process.',
    };
  }
  return {
    status: 'ok',
    protocolVersion: 'fixture-2026-11-01',
    capabilities: ['tools'],
    clientLoad: 'unknown',
    tools: toolsFor(server.name),
  };
}

function nextEntry(
  state: FixtureState,
  mutation: McpServerMutation,
  host: FixtureHost,
): McpServerEntry {
  state.fingerprintNonce += 1;
  return {
    name: mutation.name,
    scope: mutation.scope,
    transport: mutation.transport ?? 'http',
    origin: host === 'ai' ? '~/.config/ai/mcp.json' : '.claude/settings.local.json',
    ...(mutation.endpoint ? { endpoint: mutation.endpoint } : {}),
    ...(mutation.command ? { command: mutation.command } : {}),
    ...(mutation.argumentCount !== undefined
      ? { argumentCount: mutation.argumentCount }
      : {}),
    ...(mutation.envNames ? { envNames: mutation.envNames } : {}),
    ...(mutation.headerNames ? { headerNames: mutation.headerNames } : {}),
    readOnly: false,
    effective: true,
    conflict: false,
    credential: 'bound',
    fingerprint: `fixture-${mutation.name}-${state.fingerprintNonce}`,
  };
}

function mutateFixture(
  state: FixtureState,
  mutation: McpServerMutation,
  host: FixtureHost,
  scopes: readonly McpScope[],
) {
  if (!scopes.includes(mutation.scope)) {
    return { state: 'refused' as const, message: 'This adapter does not write that scope.' };
  }
  const existing = state.servers.find(
    (entry) => entry.name === mutation.name && entry.scope === mutation.scope,
  );
  if (existing?.readOnly) {
    return { state: 'refused' as const, message: 'That definition is read-only.' };
  }
  if (mutation.action === 'remove') {
    if (!existing) {
      return { state: 'refused' as const, message: 'No writable definition to remove.' };
    }
    state.servers = state.servers.filter((entry) => entry !== existing);
    return { state: 'ok' as const };
  }
  if (mutation.action === 'create' && existing) {
    return { state: 'refused' as const, message: 'A server with that name already exists.' };
  }
  if (
    mutation.action === 'update' &&
    existing &&
    mutation.expectedFingerprint &&
    existing.fingerprint !== mutation.expectedFingerprint
  ) {
    return { state: 'conflict' as const, message: 'The definition changed after review.' };
  }
  const next = nextEntry(state, mutation, host);
  state.servers = existing
    ? state.servers.map((entry) => (entry === existing ? next : entry))
    : [...state.servers, next];
  return { state: 'ok' as const };
}

function invokeFixture({
  state,
  name,
  tool,
  args,
  scenario,
}: {
  state: FixtureState;
  name: string;
  tool: string;
  args: Record<string, unknown>;
  scenario: FixtureScenario;
}): McpCallResult {
  if (!state.servers.some((entry) => entry.name === name)) {
    throw new Error('The selected server no longer exists.');
  }
  if (scenario === 'error') {
    return {
      structuredContent: { code: 'PERMISSION_DENIED', message: 'Synthetic failure' },
      content: [{ type: 'text', text: 'Synthetic permission denied' }],
      isError: true,
      raw: {
        isError: true,
        structuredContent: { code: 'PERMISSION_DENIED' },
        _meta: { provider: 'fixture' },
      },
    };
  }
  if (tool === 'session.rename') {
    return {
      structuredContent: { updated: true, session_id: String(args.session_id ?? '') },
      content: [{ type: 'text', text: 'Fixture rename completed.' }],
      isError: false,
      raw: { structuredContent: { updated: true }, _meta: { provider: 'fixture' } },
    };
  }
  return callResult(name, tool);
}

function fixtureProvider({
  host,
  scenario,
  agentId,
  sessionId,
}: {
  host: FixtureHost;
  scenario: FixtureScenario;
  agentId: string;
  sessionId: string;
}): McpUiProvider {
  const state: FixtureState = {
    servers: initialServers(host, scenario),
    fingerprintNonce: 0,
  };
  const scopes: readonly McpScope[] = host === 'ai' ? ['user'] : ['local', 'project'];
  return {
    context: {
      agentId,
      sessionId,
      hostTitle: host === 'ai' ? 'AI' : 'Claude Code',
    },
    capabilities: {
      configuration: true,
      probe: true,
      discovery: true,
      invocation: true,
      scopes: [...scopes],
    },
    async listServers(): Promise<McpInventory> {
      return listFixture(state, scenario);
    },
    async probeServer(name, _scope, options): Promise<McpProbeResult> {
      return probeFixture(state, name, options, scenario);
    },
    async mutateServer(mutation: McpServerMutation) {
      return mutateFixture(state, mutation, host, scopes);
    },
    async invokeTool(name, _scope, tool, args): Promise<McpCallResult> {
      return invokeFixture({ state, name, tool, args, scenario });
    },
  };
}

/**
 * Deterministic host for the MCP kit (#3772).
 *
 * This is a fixture *host*, not a second product capability: it supplies the
 * provider inputs and the surrounding capability chrome, while the kit renders
 * the real interaction grammar. The route's `mcp` and `mcpHost` inputs choose
 * the adapter shape the Case reviews; neither is reachable from product
 * navigation.
 */
export function FixtureMcpUiKit({
  ctx,
  experience,
  depth,
}: {
  ctx: WorkspaceContext;
  experience: 'web' | 'app';
  depth?: WorkspaceDepthControl;
}) {
  const search = useLocation().search;
  const host = hostOf(search);
  const scenario = scenarioOf(search);
  const agentId = ctx.agent?.agent_id ?? 'devbox-01';
  const sessionId = ctx.session?.session_id ?? 'devbox-01:fix-terminal-reconnect';
  const provider = useMemo(
    () => fixtureProvider({ host, scenario, agentId, sessionId }),
    [agentId, host, scenario, sessionId],
  );

  if (!ctx.session) {
    return (
      <div className="p-3" data-testid="mcp-kit-no-session">
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          MCP configuration is bound to the current Session Agent. No Session is open.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mcp-kit-host">
      {experience === 'web' ? (
        <header className="flex min-w-0 flex-col gap-1 border-b border-border px-3 py-2">
          <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Current Session · {agentId} · {sessionId}
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className={cn('min-w-0', chromeSansRole('title'))}>
              {host === 'ai' ? 'AI' : 'Claude Code'} · MCP
            </h1>
            <span
              className={cn(
                'rounded-[var(--nession-radius-control)] bg-accent px-2 py-1 text-accent-foreground',
                chromeSansRole('caption'),
              )}
              data-testid="mcp-kit-host-tab"
            >
              MCP
            </span>
          </div>
        </header>
      ) : null}
      <div className="min-h-0 flex-1">
        <McpKitView
          provider={provider}
          agentId={agentId}
          sessionId={sessionId}
          experience={experience}
          depth={depth}
        />
      </div>
    </div>
  );
}
