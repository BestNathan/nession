import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SandboxActionResult,
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
  SandboxImplementationSupport,
  SandboxPolicyDraft,
  SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { SandboxWorkspace } from '../../components/SandboxWorkspace';

// The component talks to the Agent only through the plugin singleton; keep the
// fake here so each test drives the exact wire answers (the same seam the Git
// hooks use).
const api = vi.hoisted(() => ({
  context: vi.fn(),
  preflight: vi.fn(),
  enter: vi.fn(),
  returnToNative: vi.fn(),
  focus: vi.fn(),
}));

vi.mock('../../SandboxPlugin', () => ({
  sandboxApi: api,
  SandboxPlugin: class SandboxPlugin {},
}));

function catalog(): SandboxCapabilityCatalog {
  const field = (key: string, valueFormat: string, example: string) => ({
    key,
    controller: key.split('.')[0],
    value_format: valueFormat,
    example,
    available: true,
  });
  const resourceFields = [
    field('memory.max', 'uint64 bytes or `max`', '2147483648'),
    field('cpu.max', '`quota period`', '200000 100000'),
    field('pids.max', 'uint64 tasks or `max`', '256'),
    field('memory.oom.group', '`0` or `1`', '0'),
  ];
  const implementation = (
    path: string,
    options: SandboxImplementationSupport['options'] = [],
    fields: SandboxImplementationSupport['fields'] = [],
  ): SandboxImplementationSupport => ({ path, status: 'available', options, fields });
  return {
    catalog_version: 2,
    status: 'available',
    platform: 'linux',
    backend: 'linux-bwrap',
    probe_generation: 'probe-1',
    source: 'agent-host-probe',
    detail: ['delegated controllers: memory, cpu, pids'],
    implementations: [
      implementation('filesystem.access'),
      implementation('filesystem.composition', [
        { id: 'workspace_image', status: 'available' },
      ]),
      implementation('network', [
        { id: 'allow', status: 'available' },
        { id: 'deny', status: 'available' },
        { id: 'restricted', status: 'available' },
      ]),
      implementation(
        'process.linux_namespaces',
        ['pid', 'ipc', 'user', 'uts', 'cgroup'].map((id) => ({
          id,
          status: 'available' as const,
        })),
      ),
      implementation('resource.cgroup_v2', [], resourceFields),
      implementation('syscall.seccomp', [{ id: 'nession-interactive-v1', status: 'available' }]),
    ],
    resource_fields: resourceFields,
    syscall_fields: [field('seccomp.profile', 'profile', 'nession-interactive-v1')],
  };
}

function effectivePolicy(): SandboxPolicyDraft {
  return {
    version: 1,
    enabled: true,
    filesystem: { access: { read: ['/usr'], write: ['/workspace'] } },
    network: { mode: 'deny', ingress: 'deny' },
    process: { linux_namespaces: { pid: true, ipc: true, user: true, uts: true, cgroup: false } },
    resource: [{ key: 'cpu.max', value: '200000 100000' }],
    syscall: [{ key: 'seccomp.profile', value: 'nession-interactive-v1' }],
    enforcement: 'required',
  };
}

function outsideContext(generation = 'gen-outside'): SandboxCurrentContext {
  return {
    status: 'outside',
    scope: {
      session_name: 'dev',
      session_instance_id: 'instance-1',
      pane_id: '%1',
      window_id: '@1',
      pane_pid: 42,
      working_dir: '/workspace',
    },
    generation,
    enterable: true,
    sandbox_panes: [],
    catalog: catalog(),
  };
}

function insideContext(): SandboxCurrentContext {
  return {
    status: 'inside',
    scope: {
      session_name: 'dev',
      session_instance_id: 'instance-1',
      pane_id: '%2',
      window_id: '@2',
      pane_pid: 43,
      working_dir: '/workspace',
    },
    generation: 'gen-inside',
    execution: {
      execution_id: 'exec-1',
      backend: 'linux-bwrap',
      policy_digest: 'a'.repeat(64),
      mechanisms: ['network.deny', 'resource.cgroup_v2'],
      warnings: ['backend note'],
      pane_pid: 43,
      created_at: 1_760_000_000,
    },
    effective_policy: effectivePolicy(),
    native_pane: { window_id: '@1', pane_id: '%1' },
    enterable: false,
    sandbox_panes: [
      { execution_id: 'exec-1', window_id: '@2', pane_id: '%2', backend: 'linux-bwrap' },
    ],
    catalog: catalog(),
  };
}

function workspaceContext(): WorkspaceContext {
  return {
    session: {
      session_id: 'agent-a:dev',
      agent_id: 'agent-a',
      session_name: 'dev',
    } as never,
    agent: { agent_id: 'agent-a' } as never,
    agents: [],
    domain: null,
    fileOps: null,
    experience: 'web',
    onToolChange: () => {},
  };
}

beforeEach(() => {
  api.context.mockReset();
  api.preflight.mockReset();
  api.enter.mockReset();
  api.returnToNative.mockReset();
  api.focus.mockReset();
  api.context.mockResolvedValue({ success: true, context: outsideContext() });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SandboxWorkspace (#3124)', () => {
  it('starts the outside draft empty and requires a fresh validation for Enter', async () => {
    const user = userEvent.setup();
    api.preflight.mockImplementation(
      (request: { policy: SandboxPolicyDraft }) => {
        const draft = request.policy;
        const cpu = draft.resource.find((row) => row.key === 'cpu.max');
        const result: SandboxPreflightResult = cpu?.value === '200000 100000'
          ? {
              ok: true,
              generation: 'gen-outside',
              policy_digest: 'b'.repeat(64),
              backend: 'linux-bwrap',
              mechanisms: ['network.deny'],
              errors: [],
              warnings: [],
              catalog: catalog(),
            }
          : {
              ok: false,
              generation: 'gen-outside',
              mechanisms: [],
              errors: [
                {
                  field: 'resource[0].value',
                  code: 'invalid-value',
                  message: 'not a valid native value for cpu.max',
                },
              ],
              warnings: [],
              catalog: catalog(),
            };
        return Promise.resolve(result);
      },
    );
    render(<SandboxWorkspace ctx={workspaceContext()} />);

    expect(await screen.findByTestId('sandbox-composer')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-status')).toHaveTextContent('outside');
    for (const tab of ['overview', 'filesystem', 'network', 'process', 'resource', 'syscall']) {
      expect(screen.getByTestId(`sandbox-tab-${tab}`)).toBeInTheDocument();
    }
    // Only the selected peer panel is rendered; the five editors are not inline.
    expect(screen.queryByTestId('sandbox-resource-empty')).toBeNull();
    expect(screen.getByTestId('sandbox-enter')).toBeDisabled();

    await user.click(screen.getByTestId('sandbox-tab-resource'));
    expect(screen.getByTestId('sandbox-resource-empty')).toBeInTheDocument();
    await user.click(screen.getByTestId('sandbox-resource-add'));
    await user.type(screen.getByTestId('sandbox-resource-key-0'), 'cpu.max');
    await user.type(screen.getByTestId('sandbox-resource-value-0'), '200000 999');

    // Validation belongs to Overview; switching back preserves the draft.
    await user.click(screen.getByTestId('sandbox-tab-overview'));
    await user.click(screen.getByTestId('sandbox-preflight'));
    expect(await screen.findByTestId('sandbox-preflight-error-0')).toHaveTextContent(
      'not a valid native value',
    );
    expect(screen.getByTestId('sandbox-enter')).toBeDisabled();

    await user.click(screen.getByTestId('sandbox-tab-resource'));
    const value = screen.getByTestId('sandbox-resource-value-0');
    await user.clear(value);
    await user.type(value, '200000 100000');
    // Merely leaving the tab does not invalidate the draft or its preflight.
    await user.click(screen.getByTestId('sandbox-tab-syscall'));
    expect(screen.getByTestId('sandbox-syscall-profile')).toBeInTheDocument();
    await user.click(screen.getByTestId('sandbox-tab-overview'));
    await user.click(screen.getByTestId('sandbox-preflight'));
    expect(await screen.findByTestId('sandbox-preflight-ok')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-enter')).toBeEnabled();

    // An actual edit invalidates the validation: Enter must not be reachable
    // from a preflight that describes a different draft.
    await user.click(screen.getByTestId('sandbox-tab-resource'));
    await user.type(screen.getByTestId('sandbox-resource-value-0'), '0');
    await user.click(screen.getByTestId('sandbox-tab-overview'));
    await waitFor(() => expect(screen.queryByTestId('sandbox-preflight-ok')).toBeNull());
    expect(screen.getByTestId('sandbox-enter')).toBeDisabled();
  });

  it('confirms Enter, shows the effective policy inside, and returns to the Native Pane', async () => {
    const user = userEvent.setup();
    api.preflight.mockResolvedValue({
      ok: true,
      generation: 'gen-outside',
      policy_digest: 'b'.repeat(64),
      backend: 'linux-bwrap',
      mechanisms: ['network.deny'],
      errors: [],
      warnings: [],
      catalog: catalog(),
    } satisfies SandboxPreflightResult);
    const entered: SandboxActionResult = { success: true, context: insideContext() };
    api.enter.mockResolvedValue(entered);
    api.context.mockResolvedValueOnce({ success: true, context: outsideContext() });
    api.returnToNative.mockResolvedValue({
      success: true,
      context: { ...outsideContext('gen-returned'), sandbox_panes: insideContext().sandbox_panes },
    } satisfies SandboxActionResult);

    render(<SandboxWorkspace ctx={workspaceContext()} />);

    await screen.findByTestId('sandbox-composer');
    await user.click(screen.getByTestId('sandbox-preflight'));
    expect(await screen.findByTestId('sandbox-preflight-ok')).toBeInTheDocument();
    await user.click(screen.getByTestId('sandbox-enter'));

    expect(await screen.findByTestId('sandbox-confirm')).toBeInTheDocument();
    await user.click(screen.getByTestId('sandbox-confirm-enter'));

    expect(await screen.findByTestId('sandbox-inside')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-scope-note')).toHaveTextContent(
      'future Panes or Windows are not inside this Sandbox',
    );
    // The same peer tabs expose the observed effective policy per domain.
    await user.click(screen.getByTestId('sandbox-tab-resource'));
    expect(screen.getByTestId('sandbox-effective-resource-cpu.max')).toHaveTextContent(
      '200000 100000',
    );
    await user.click(screen.getByTestId('sandbox-tab-syscall'));
    expect(screen.getByTestId('sandbox-effective-syscall-seccomp.profile')).toBeInTheDocument();
    await user.click(screen.getByTestId('sandbox-tab-overview'));

    await user.click(screen.getByTestId('sandbox-return-native'));
    expect(await screen.findByTestId('sandbox-composer')).toBeInTheDocument();
    await user.click(screen.getByTestId('sandbox-tab-overview'));
    expect(screen.getByTestId('sandbox-existing-panes')).toHaveTextContent('%2');
  });

  it('drops the confirmation when a racing Enter reports the Pane already inside', async () => {
    const user = userEvent.setup();
    api.preflight.mockResolvedValue({
      ok: true,
      generation: 'gen-outside',
      policy_digest: 'b'.repeat(64),
      backend: 'linux-bwrap',
      mechanisms: ['network.deny'],
      errors: [],
      warnings: [],
      catalog: catalog(),
    } satisfies SandboxPreflightResult);
    api.enter.mockResolvedValue({
      success: false,
      error_kind: 'conflict',
      error: 'the active Pane is already inside a managed Sandbox',
      context: insideContext(),
    } satisfies SandboxActionResult);
    render(<SandboxWorkspace ctx={workspaceContext()} />);

    await screen.findByTestId('sandbox-composer');
    await user.click(screen.getByTestId('sandbox-preflight'));
    await screen.findByTestId('sandbox-preflight-ok');
    await user.click(screen.getByTestId('sandbox-enter'));
    await screen.findByTestId('sandbox-confirm');
    await user.click(screen.getByTestId('sandbox-confirm-enter'));

    expect(await screen.findByTestId('sandbox-inside')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-confirm')).toBeNull();
  });

  it('shows a verified inside context from the Agent without a draft', async () => {
    api.context.mockResolvedValue({ success: true, context: insideContext() });
    render(<SandboxWorkspace ctx={workspaceContext()} />);

    expect(await screen.findByTestId('sandbox-inside')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-backend')).toHaveTextContent('linux-bwrap');
    expect(screen.getByTestId('sandbox-execution-id')).toHaveTextContent('exec-1');
    expect(screen.getByTestId('sandbox-mechanism-network.deny')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-composer')).toBeNull();
  });

  it('never claims protection or offers Enter when the context is unknown', async () => {
    api.context.mockResolvedValue({
      success: true,
      context: {
        ...outsideContext(),
        status: 'unknown',
        reason: 'the Session’s instance identity changed',
        enterable: false,
      },
    });
    render(<SandboxWorkspace ctx={workspaceContext()} />);

    expect(await screen.findByTestId('sandbox-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-status')).toHaveTextContent('unknown');
    expect(screen.queryByTestId('sandbox-enter')).toBeNull();
    expect(screen.queryByTestId('sandbox-inside')).toBeNull();
  });

  it('reports an unreachable Agent without an inside claim and can retry', async () => {
    api.context.mockResolvedValue({ success: false, error: 'Agent did not answer' });
    render(<SandboxWorkspace ctx={workspaceContext()} />);

    expect(await screen.findByTestId('sandbox-context-error')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-inside')).toBeNull();
    expect(screen.getByTestId('sandbox-retry')).toBeInTheDocument();
  });

  it('renders per-implementation support and disables unmeasured options and fields', async () => {
    const user = userEvent.setup();
    const base = outsideContext();
    const partial: SandboxCurrentContext = {
      ...base,
      catalog: {
        ...base.catalog,
        implementations: base.catalog.implementations.map((implementation) => {
          if (implementation.path === 'network') {
            return {
              ...implementation,
              options: [
                { id: 'allow', status: 'available' as const },
                { id: 'deny', status: 'available' as const },
                {
                  id: 'restricted',
                  status: 'unavailable' as const,
                  reason_code: 'platform_unsupported' as const,
                  reason: 'restricted is not supported',
                },
              ],
            };
          }
          if (implementation.path === 'process.linux_namespaces') {
            return {
              ...implementation,
              options: implementation.options?.map((option) =>
                option.id === 'pid'
                  ? {
                      ...option,
                      status: 'unavailable' as const,
                      reason_code: 'kernel_feature_missing' as const,
                      reason: 'no pid namespace',
                    }
                  : option,
              ),
            };
          }
          if (implementation.path === 'resource.cgroup_v2') {
            return {
              ...implementation,
              fields: implementation.fields?.map((field) =>
                field.key === 'cpu.max'
                  ? {
                      ...field,
                      available: false,
                      reason_code: 'controller_not_delegated' as const,
                      reason: 'cpu is not delegated',
                    }
                  : field,
              ),
            };
          }
          if (implementation.path === 'syscall.seccomp') {
            return {
              ...implementation,
              status: 'unavailable' as const,
              reason_code: 'profile_unavailable' as const,
              reason: 'no loadable profile',
              options: [],
            };
          }
          return implementation;
        }),
      },
    };
    api.context.mockResolvedValue({ success: true, context: partial });
    render(<SandboxWorkspace ctx={workspaceContext()} />);

    await screen.findByTestId('sandbox-composer');
    await user.click(screen.getByTestId('sandbox-tab-network'));
    expect(screen.getByTestId('sandbox-implementation-status-network')).toHaveTextContent(
      'available',
    );
    await user.click(screen.getByTestId('sandbox-tab-syscall'));
    expect(
      screen.getByTestId('sandbox-implementation-status-syscall.seccomp'),
    ).toHaveTextContent('unavailable');
    expect(screen.getByTestId('sandbox-syscall-disabled')).toHaveTextContent(
      'no loadable profile',
    );
    expect(screen.getByTestId('sandbox-syscall-profile')).toBeDisabled();
    await user.click(screen.getByTestId('sandbox-tab-process'));
    expect(screen.getByTestId('sandbox-namespace-pid')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByTestId('sandbox-namespace-ipc')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await user.click(screen.getByTestId('sandbox-tab-resource'));
    await user.click(screen.getByTestId('sandbox-resource-add'));
    await user.type(screen.getByTestId('sandbox-resource-key-0'), 'cpu.max');
    expect(screen.getByTestId('sandbox-resource-value-0')).toBeDisabled();
    expect(screen.getByTestId('sandbox-resource-value-unavailable-0')).toHaveTextContent(
      'cpu is not delegated',
    );
  });

  it('switches all six peer tabs directly and renders only the selected panel', async () => {
    const user = userEvent.setup();
    render(<SandboxWorkspace ctx={workspaceContext()} />);
    await screen.findByTestId('sandbox-composer');
    expect(screen.getByTestId('sandbox-tabs')).toHaveAttribute(
      'aria-orientation',
      'vertical',
    );

    const panelContent: Record<string, string> = {
      overview: 'sandbox-policy-preview',
      filesystem: 'sandbox-fs-read',
      network: 'sandbox-network-mode',
      process: 'sandbox-namespace-pid',
      resource: 'sandbox-resource-add',
      syscall: 'sandbox-syscall-profile',
    };
    for (const tab of ['overview', 'filesystem', 'network', 'process', 'resource', 'syscall']) {
      await user.click(screen.getByTestId(`sandbox-tab-${tab}`));
      expect(screen.getByTestId(`sandbox-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId(panelContent[tab])).toBeInTheDocument();
    }

    // The Overview summary is a second direct switch to the same peer tabs.
    await user.click(screen.getByTestId('sandbox-tab-overview'));
    await user.click(screen.getByTestId('sandbox-summary-network'));
    expect(screen.getByTestId('sandbox-tabpanel-network')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-network-mode')).toBeInTheDocument();
  });

  it('keeps the inside domain tabs read-only and shows observed data only', async () => {
    const user = userEvent.setup();
    const erofs = insideContext();
    erofs.execution = erofs.execution
      ? {
          ...erofs.execution,
          mechanisms: ['filesystem.erofs', 'network.deny', 'syscall.seccomp'],
        }
      : erofs.execution;
    api.context.mockResolvedValue({ success: true, context: erofs });
    render(<SandboxWorkspace ctx={workspaceContext()} />);

    expect(await screen.findByTestId('sandbox-inside')).toBeInTheDocument();
    await user.click(screen.getByTestId('sandbox-tab-filesystem'));
    expect(screen.getByTestId('sandbox-effective-erofs')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-fs-read')).toBeNull();
    expect(screen.queryByTestId('sandbox-fs-write')).toBeNull();

    await user.click(screen.getByTestId('sandbox-tab-resource'));
    expect(screen.getByTestId('sandbox-effective-resource-cpu.max')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-resource-add')).toBeNull();

    await user.click(screen.getByTestId('sandbox-tab-syscall'));
    expect(screen.getByTestId('sandbox-effective-syscall-seccomp.profile')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-syscall-profile')).toBeNull();
  });
});
