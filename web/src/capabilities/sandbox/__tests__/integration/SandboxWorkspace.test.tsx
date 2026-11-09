import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SandboxActionResult,
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
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
    value_format: valueFormat,
    example,
    available: true,
  });
  return {
    status: 'available',
    platform: 'linux',
    backend: 'linux-bwrap',
    probe_generation: 'probe-1',
    source: 'agent-host-probe',
    detail: ['delegated controllers: memory, cpu, pids'],
    resource_fields: [
      field('memory.max', 'uint64 bytes or `max`', '2147483648'),
      field('cpu.max', '`quota period`', '200000 100000'),
      field('pids.max', 'uint64 tasks or `max`', '256'),
      field('memory.oom.group', '`0` or `1`', '0'),
    ],
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
      (_sessionId: string, _generation: string, draft: SandboxPolicyDraft) => {
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
    expect(screen.getByTestId('sandbox-resource-empty')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-syscall-empty')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-enter')).toBeDisabled();

    await user.click(screen.getByTestId('sandbox-resource-add'));
    await user.type(screen.getByTestId('sandbox-resource-key-0'), 'cpu.max');
    await user.type(screen.getByTestId('sandbox-resource-value-0'), '200000 999');
    await user.click(screen.getByTestId('sandbox-preflight'));

    expect(await screen.findByTestId('sandbox-preflight-error-0')).toHaveTextContent(
      'not a valid native value',
    );
    expect(screen.getByTestId('sandbox-enter')).toBeDisabled();

    const value = screen.getByTestId('sandbox-resource-value-0');
    await user.clear(value);
    await user.type(value, '200000 100000');
    await user.click(screen.getByTestId('sandbox-preflight'));

    expect(await screen.findByTestId('sandbox-preflight-ok')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-enter')).toBeEnabled();

    // An edit invalidates the validation: Enter must not be reachable from a
    // preflight that describes a different draft.
    await user.type(value, '0');
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
    expect(screen.getByTestId('sandbox-effective-resource-cpu.max')).toHaveTextContent(
      '200000 100000',
    );
    expect(screen.getByTestId('sandbox-effective-syscall-seccomp.profile')).toBeInTheDocument();

    await user.click(screen.getByTestId('sandbox-return-native'));
    expect(await screen.findByTestId('sandbox-composer')).toBeInTheDocument();
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
});
