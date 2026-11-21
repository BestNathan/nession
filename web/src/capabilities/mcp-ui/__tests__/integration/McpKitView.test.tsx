import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import { McpKitView } from '../../components/McpKitView';
import type {
  McpCallResult,
  McpInventory,
  McpMutationResult,
  McpProbeResult,
  McpProviderCapabilities,
  McpServerEntry,
  McpTool,
  McpUiProvider,
} from '../../types';

function server(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name: 'nession',
    scope: 'user',
    transport: 'http',
    origin: '~/.config/ai/mcp.json',
    endpoint: 'https://agent.invalid/mcp',
    readOnly: false,
    effective: true,
    conflict: false,
    credential: 'bound',
    fingerprint: 'fp-1',
    ...overrides,
  };
}

function tool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 'session.list',
    description: 'List Sessions.',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['current', 'all'], description: 'Which Sessions.' },
      },
      required: ['scope'],
    },
    outputSchema: {
      type: 'object',
      properties: { sessions: { type: 'array', items: { type: 'object' } } },
      required: ['sessions'],
    },
    ...overrides,
  };
}

function okCall(overrides: Partial<McpCallResult> = {}): McpCallResult {
  return {
    structuredContent: { sessions: [{ id: 'fixture-session' }], next_cursor: null },
    content: [{ type: 'text', text: 'Fixture call completed.' }],
    isError: false,
    raw: {
      structuredContent: { sessions: [{ id: 'fixture-session' }] },
      _meta: { provider: 'test', unknownField: { preserved: true } },
    },
    ...overrides,
  };
}

const pendingInvoke: NonNullable<McpUiProvider['invokeTool']> = (...args) =>
  new Promise<McpCallResult>((_resolve, reject) => {
    const signal = args[4];
    signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeProvider({
  servers = [server()],
  tools = [tool()],
  capabilities = {},
  inventoryState = 'ready',
  probeResult,
  callResult = okCall(),
  sessionId = 'a1:work',
  invoke,
}: {
  servers?: McpServerEntry[];
  tools?: McpTool[];
  capabilities?: Partial<McpProviderCapabilities>;
  inventoryState?: McpInventory['state'];
  probeResult?: McpProbeResult;
  callResult?: McpCallResult;
  sessionId?: string;
  invoke?: McpUiProvider['invokeTool'];
} = {}) {
  const listServers = vi.fn(
    async (): Promise<McpInventory> => ({
      state: inventoryState,
      servers: inventoryState === 'ready' ? servers : [],
      ...(inventoryState === 'ready' ? {} : { error: 'Inventory unavailable.' }),
    }),
  );
  const probeServer = vi.fn(
    async (): Promise<McpProbeResult> =>
      probeResult ?? {
        status: 'ok',
        protocolVersion: 'v1',
        clientLoad: 'unknown',
        tools,
      },
  );
  const mutateServer = vi.fn(async (): Promise<McpMutationResult> => ({ state: 'ok' }));
  const invokeTool = vi.fn(
    invoke ??
      (async () => callResult),
  );
  const provider: McpUiProvider = {
    context: { agentId: 'a1', sessionId, hostTitle: 'AI' },
    capabilities: {
      configuration: true,
      probe: true,
      discovery: true,
      invocation: true,
      scopes: ['user'],
      ...capabilities,
    },
    listServers,
    probeServer,
    mutateServer,
    invokeTool,
  };
  return { provider, listServers, probeServer, mutateServer, invokeTool };
}

function renderKit(
  provider: McpUiProvider,
  experience: 'web' | 'app' = 'web',
  depth?: WorkspaceDepthControl,
) {
  return render(
    <McpKitView
      provider={provider}
      agentId={provider.context.agentId}
      sessionId={provider.context.sessionId}
      experience={experience}
      depth={depth}
      timeoutMs={60}
    />,
  );
}

async function selectServer(name = 'nession') {
  const row = (await screen.findAllByTestId('mcp-server-row')).find(
    (candidate) => candidate.getAttribute('data-server-name') === name,
  );
  expect(row).toBeDefined();
  await userEvent.click(row!);
}

async function probeAndSelectTool() {
  await selectServer();
  await userEvent.click(screen.getByTestId('mcp-connection-test'));
  const rows = await screen.findAllByTestId('mcp-tool-row');
  await userEvent.click(rows[0]);
}

describe('MCP UI kit', () => {
  it('reads configuration on mount and never probes or invokes by itself', async () => {
    const kit = makeProvider();
    renderKit(kit.provider);
    await screen.findByTestId('mcp-server-row');
    expect(kit.listServers).toHaveBeenCalledTimes(1);
    expect(kit.probeServer).not.toHaveBeenCalled();
    expect(kit.invokeTool).not.toHaveBeenCalled();

    await selectServer();
    expect(screen.getByTestId('mcp-connection-state')).toHaveTextContent('Not probed');
    expect(screen.getByTestId('mcp-tools-not-probed')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-tool-row')).toBeNull();
    expect(kit.probeServer).not.toHaveBeenCalled();
    expect(kit.invokeTool).not.toHaveBeenCalled();
  });

  it('keeps configured, probed and client-loaded independent', async () => {
    const kit = makeProvider({ probeResult: { status: 'ok', protocolVersion: 'v1' } });
    renderKit(kit.provider);
    await selectServer();

    expect(screen.getByTestId('mcp-connection-configured')).toHaveTextContent('Yes');
    expect(screen.getByTestId('mcp-connection-reachability')).toHaveTextContent('Not probed');
    expect(screen.getByTestId('mcp-connection-loaded')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('mcp-connection-protocol')).toHaveTextContent('Not negotiated');

    await userEvent.click(screen.getByTestId('mcp-connection-test'));
    await waitFor(() =>
      expect(screen.getByTestId('mcp-connection-reachability')).toHaveTextContent('Reachable'),
    );
    expect(kit.probeServer).toHaveBeenCalledWith('nession', 'user', { allowStdio: false });
    // The probe did not report a client load, so the kit does not invent one.
    expect(screen.getByTestId('mcp-connection-loaded')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('mcp-connection-protocol')).toHaveTextContent('v1');
  });

  it('asks for consent before a stdio probe launches a process', async () => {
    const kit = makeProvider({ servers: [server({ name: 'github', transport: 'stdio' })] });
    renderKit(kit.provider);
    await selectServer('github');

    await userEvent.click(screen.getByTestId('mcp-connection-test'));
    expect(kit.probeServer).not.toHaveBeenCalled();
    expect(screen.getByTestId('mcp-connection-consent')).toHaveTextContent('launches');

    await userEvent.click(screen.getByTestId('mcp-connection-consent-confirm'));
    await waitFor(() => expect(kit.probeServer).toHaveBeenCalledTimes(1));
    expect(kit.probeServer).toHaveBeenCalledWith('github', 'user', { allowStdio: true });
  });

  it('fails closed for a missing credential and shows unavailable inventory as not empty', async () => {
    const missing = makeProvider({ servers: [server({ credential: 'missing' })] });
    const view = renderKit(missing.provider);
    await selectServer();
    expect(screen.getByTestId('mcp-connection-test')).toBeDisabled();
    expect(screen.getByTestId('mcp-connection-credential-missing')).toHaveTextContent(
      'never exports tokens implicitly',
    );
    view.unmount();

    const offline = makeProvider({ inventoryState: 'unavailable' });
    renderKit(offline.provider);
    expect(await screen.findByTestId('mcp-inventory-unavailable')).toHaveTextContent(
      'unavailable, not empty',
    );
    expect(screen.queryByTestId('mcp-server-empty')).toBeNull();
  });

  it('shows readable and complete raw schemas, and an honest missing output schema', async () => {
    const external = tool({
      name: 'search_repositories',
      description: 'External search.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search text.' } },
        required: ['query'],
      },
      outputSchema: undefined,
    });
    const kit = makeProvider({ tools: [tool(), external] });
    renderKit(kit.provider);
    await probeAndSelectTool();

    expect(screen.getByTestId('mcp-schema-input-fields')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-schema-input-raw')).toHaveTextContent('"required"');
    expect(screen.getByTestId('mcp-schema-output-fields')).toBeInTheDocument();

    await userEvent.click(
      screen.getAllByTestId('mcp-tool-row').find((row) =>
        row.textContent?.includes('search_repositories'),
      )!,
    );
    expect(screen.getByTestId('mcp-schema-output-missing')).toHaveTextContent('not advertised');
    expect(screen.getByTestId('mcp-schema-input-raw')).toHaveTextContent('"query"');
  });

  it('never calls from inspection; validates the draft, then invokes explicitly', async () => {
    const kit = makeProvider();
    renderKit(kit.provider);
    await probeAndSelectTool();
    expect(kit.invokeTool).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('mcp-open-runner'));
    await userEvent.click(screen.getByTestId('mcp-run'));
    expect(screen.getByTestId('mcp-argument-error')).toHaveTextContent('Required: scope');
    expect(kit.invokeTool).not.toHaveBeenCalled();

    await userEvent.type(screen.getByTestId('mcp-argument'), 'current');
    await userEvent.click(screen.getByTestId('mcp-run'));
    await waitFor(() => expect(kit.invokeTool).toHaveBeenCalledTimes(1));
    expect(kit.invokeTool).toHaveBeenCalledWith(
      'nession',
      'user',
      'session.list',
      { scope: 'current' },
      expect.any(AbortSignal),
    );
    expect(screen.getByTestId('mcp-result-structured')).toHaveTextContent('fixture-session');
    expect(screen.getByTestId('mcp-call-history-row')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('mcp-result-tab-content'));
    expect(screen.getByTestId('mcp-result-content-text')).toHaveTextContent('Fixture call');
    await userEvent.click(screen.getByTestId('mcp-result-tab-raw'));
    expect(screen.getByTestId('mcp-result-raw')).toHaveTextContent('unknownField');
  });

  it('requires a second confirmation for a write, and cancels a busy call', async () => {
    const write = tool({ name: 'session.rename', effect: 'write' });
    const pending = makeProvider({
      tools: [write],
      invoke: pendingInvoke,
    });
    renderKit(pending.provider);
    await probeAndSelectTool();
    await userEvent.click(screen.getByTestId('mcp-open-runner'));
    await userEvent.click(screen.getByTestId('mcp-argument'));
    await userEvent.type(screen.getByTestId('mcp-argument'), 'current');
    await userEvent.click(screen.getByTestId('mcp-run'));

    expect(screen.getByTestId('mcp-run-confirmation')).toBeInTheDocument();
    expect(pending.invokeTool).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('mcp-run-confirm'));
    await waitFor(() => expect(pending.invokeTool).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByTestId('mcp-run-cancel'));
    await waitFor(() =>
      expect(screen.getByTestId('mcp-result-error')).toHaveTextContent('cancelled'),
    );
  });

  it('treats isError as an answer, not a transport failure', async () => {
    const kit = makeProvider({
      callResult: {
        structuredContent: { code: 'PERMISSION_DENIED' },
        content: [{ type: 'text', text: 'Denied' }],
        isError: true,
        raw: { isError: true },
      },
    });
    renderKit(kit.provider);
    await probeAndSelectTool();
    await userEvent.click(screen.getByTestId('mcp-open-runner'));
    await userEvent.type(screen.getByTestId('mcp-argument'), 'current');
    await userEvent.click(screen.getByTestId('mcp-run'));

    expect(await screen.findByTestId('mcp-result-is-error')).toHaveTextContent('isError: true');
    expect(screen.getByTestId('mcp-result-structured')).toHaveTextContent('PERMISSION_DENIED');
  });

  it('redacts credential-looking values before rendering a result', async () => {
    const kit = makeProvider({
      callResult: {
        structuredContent: { authorization: 'Bearer fixture-secret-token', ok: true },
        content: [{ type: 'text', text: 'token=abcdefghijkl' }],
        isError: false,
        raw: { api_key: 'sk-fixture-secret', nested: { token: 'fixture-secret' } },
      },
    });
    renderKit(kit.provider);
    await probeAndSelectTool();
    await userEvent.click(screen.getByTestId('mcp-open-runner'));
    await userEvent.type(screen.getByTestId('mcp-argument'), 'current');
    await userEvent.click(screen.getByTestId('mcp-run'));

    expect(await screen.findByTestId('mcp-result-redacted')).toHaveTextContent('redacted');
    const structured = screen.getByTestId('mcp-result-structured').textContent ?? '';
    expect(structured).toContain('[redacted]');
    expect(structured).not.toContain('fixture-secret-token');
    await userEvent.click(screen.getByTestId('mcp-result-tab-content'));
    expect(screen.getByTestId('mcp-result-content-text')).not.toHaveTextContent('abcdefghijkl');
    await userEvent.click(screen.getByTestId('mcp-result-tab-raw'));
    expect(screen.getByTestId('mcp-result-raw')).not.toHaveTextContent('sk-fixture-secret');
  });

  it('times out a call that outlives the kit bound and can be cancelled', async () => {
    const kit = makeProvider({
      invoke: pendingInvoke,
    });
    renderKit(kit.provider);
    await probeAndSelectTool();
    await userEvent.click(screen.getByTestId('mcp-open-runner'));
    await userEvent.type(screen.getByTestId('mcp-argument'), 'current');
    await userEvent.click(screen.getByTestId('mcp-run'));

    expect(await screen.findByTestId('mcp-result-error')).toHaveTextContent('timed out');
  });

  it('drops a previous Session’s late probe and resets the view', async () => {
    const held = deferred<McpProbeResult>();
    const first = makeProvider({ sessionId: 'a1:work' });
    first.probeServer.mockImplementation(() => held.promise);
    const second = makeProvider({
      sessionId: 'a1:other',
      servers: [server({ name: 'other-session' })],
    });
    const view = renderKit(first.provider);
    await selectServer();
    await userEvent.click(screen.getByTestId('mcp-connection-test'));
    expect(first.probeServer).toHaveBeenCalledTimes(1);

    view.rerender(
      <McpKitView
        provider={second.provider}
        agentId="a1"
        sessionId="a1:other"
        experience="web"
      />,
    );
    expect(await screen.findByText('other-session')).toBeInTheDocument();

    await act(async () => {
      held.resolve({ status: 'ok', tools: [tool()] });
    });
    expect(screen.queryByTestId('mcp-tool-row')).toBeNull();
    expect(screen.getByTestId('mcp-detail-empty')).toBeInTheDocument();
  });

  it('uses the host’s App depth and renders no Back, Sidebar or Agent picker', async () => {
    const setPush = vi.fn();
    renderKit(makeProvider().provider, 'app', { setPush });
    await selectServer();
    expect(setPush).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'nession', onLeave: expect.any(Function) }),
    );
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeNull();

    const calls = setPush.mock.calls;
    const push = calls[calls.length - 1]?.[0] as { onLeave: () => void };
    act(() => push.onLeave());
    expect(screen.getByTestId('mcp-server-list')).toBeInTheDocument();
    expect(setPush).toHaveBeenLastCalledWith(null);
  });

  it('offers configuration only where the adapter authorizes it', async () => {
    const unsupported = makeProvider({ capabilities: { configuration: false } });
    const view = renderKit(unsupported.provider);
    await selectServer();
    expect(screen.queryByTestId('mcp-server-add')).toBeNull();
    expect(screen.queryByTestId('mcp-server-edit')).toBeNull();
    expect(screen.getByTestId('mcp-server-config-unsupported')).toBeInTheDocument();
    view.unmount();

    const readOnly = makeProvider({ servers: [server({ readOnly: true })] });
    renderKit(readOnly.provider);
    await selectServer();
    expect(screen.queryByTestId('mcp-server-edit')).toBeNull();
    expect(screen.getByTestId('mcp-server-read-only')).toBeInTheDocument();
  });

  it('creates a definition at the adapter scope and reloads the inventory', async () => {
    const kit = makeProvider({ servers: [server()] });
    renderKit(kit.provider);
    await screen.findByTestId('mcp-server-row');
    await userEvent.click(screen.getByTestId('mcp-server-add'));

    expect(screen.getByTestId('mcp-editor-scope')).toHaveTextContent('User');
    expect(screen.queryByText('Local')).toBeNull();
    await userEvent.type(screen.getByTestId('mcp-editor-name'), 'new-server');
    await userEvent.type(screen.getByTestId('mcp-editor-endpoint'), 'https://example.invalid/x');
    await userEvent.click(screen.getByTestId('mcp-editor-save'));

    await waitFor(() => expect(kit.mutateServer).toHaveBeenCalledTimes(1));
    expect(kit.mutateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        name: 'new-server',
        scope: 'user',
        endpoint: 'https://example.invalid/x',
      }),
    );
    await waitFor(() => expect(kit.listServers).toHaveBeenCalledTimes(2));
  });

  it('confirms removal and surfaces an adapter conflict without pretending success', async () => {
    const kit = makeProvider();
    kit.mutateServer.mockResolvedValue({ state: 'conflict', message: 'Changed after review.' });
    renderKit(kit.provider);
    await selectServer();
    await userEvent.click(screen.getByTestId('mcp-server-remove'));
    await userEvent.click(screen.getByTestId('mcp-server-remove-confirm-button'));

    await waitFor(() =>
      expect(screen.getByTestId('mcp-server-mutation-error')).toHaveTextContent(
        'Changed after review',
      ),
    );
    expect(kit.mutateServer).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'remove', name: 'nession', scope: 'user' }),
    );
  });

  it('discloses an adapter without invocation instead of offering a call', async () => {
    const kit = makeProvider({ capabilities: { invocation: false } });
    renderKit(kit.provider);
    await probeAndSelectTool();
    await userEvent.click(screen.getByTestId('mcp-open-runner'));
    expect(screen.getByTestId('mcp-run-unsupported')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-run')).toBeDisabled();
  });
});
