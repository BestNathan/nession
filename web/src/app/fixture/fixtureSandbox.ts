import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import {
  WIRE as CONTEXT_WIRE,
  type SandboxActionResult,
  type SandboxCapabilityCatalog,
  type SandboxContextResponse,
  type SandboxCurrentContext,
  type SandboxFieldError,
  type SandboxImplementationStatus,
  type SandboxKvEntry,
  type SandboxUnsupportedReason,
  type SandboxPolicyDraft,
  type SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { WIRE as ENTER_WIRE } from '@/generated/protocol/core/server-session-sandbox-enter/v1';
import { WIRE as FOCUS_WIRE } from '@/generated/protocol/core/server-session-sandbox-focus/v1';
import { WIRE as PREFLIGHT_WIRE } from '@/generated/protocol/core/server-session-sandbox-preflight/v1';
import { WIRE as RETURN_WIRE } from '@/generated/protocol/core/server-session-sandbox-return-to-native/v1';
import { FIXTURE_AGENTS, FIXTURE_SELECTED_ID } from './fixtureData';

/**
 * A canned Sandbox Agent for the fixture routes (#3124).
 *
 * The route names what the Agent answered, never a rendered state: the
 * capability view decides what "outside", "inside", "unknown" or an
 * uninstallable `cpu.max` looks like.
 *
 *   /#/fixture/workspace?capability=sandbox                  → outside, full catalog
 *   /#/fixture/workspace?capability=sandbox&sandbox=inside   → verified effective policy
 *   …&sandbox=limited     → memory/pids delegated; no cpu.max
 *   …&sandbox=macos       → Seatbelt; no Linux-native Resource/Syscall keys
 *   …&sandbox=unsupported → backend unavailable, no Enter
 *   …&sandbox=unknown     → stale instance; no protection claim
 *   …&sandbox=offline     → the context read fails (Agent unreachable)
 *   …&sandbox=preflight-fail → validation blocked by host capability
 *   …&sandbox=enter-fail  → validated, then the launch barrier refuses
 *   …&sandbox=agent-cache-failed → a selected image's Agent cache failed
 *   …&sandbox=agent-cache-downloading → one digest is actively downloading
 *   …&sandbox=agent-cache-resumable → a verified partial download survives
 *
 * The row validation below is a **fixture mirror** of the Agent's rules, so a
 * browser Case can drive the UI's field-error rendering. It is not a second
 * policy authority: the Rust materializer and compiler remain canonical.
 */

const SESSION = FIXTURE_SELECTED_ID;
const INSTANCE = 'fixture-instance-1';

type Scenario =
  | 'outside'
  | 'inside'
  | 'inside-erofs'
  | 'limited'
  | 'macos'
  | 'unsupported'
  | 'unknown'
  | 'offline'
  | 'preflight-fail'
  | 'enter-fail'
  | 'agent-cache-failed'
  | 'agent-cache-downloading'
  | 'agent-cache-resumable';

function scenarioOf(search: string): Scenario {
  const requested = new URLSearchParams(search).get('sandbox');
  switch (requested) {
    case 'inside':
    case 'inside-erofs':
    case 'limited':
    case 'macos':
    case 'unsupported':
    case 'unknown':
    case 'offline':
    case 'preflight-fail':
    case 'enter-fail':
    case 'agent-cache-failed':
    case 'agent-cache-downloading':
    case 'agent-cache-resumable':
      return requested;
    default:
      return 'outside';
  }
}

function fieldEntry(entry: {
  key: string;
  valueFormat: string;
  example: string;
  controller?: string;
  available?: boolean;
  reasonCode?: SandboxUnsupportedReason;
  reason?: string;
}) {
  const available = entry.available ?? true;
  return {
    key: entry.key,
    controller: entry.controller,
    value_format: entry.valueFormat,
    example: entry.example,
    available,
    reason_code: available ? undefined : (entry.reasonCode ?? 'permission_denied'),
    reason: available ? undefined : (entry.reason ?? 'not measured'),
  };
}

function optionEntry(
  id: string,
  status: SandboxImplementationStatus = 'available',
  reason?: string,
  reasonCode?: SandboxUnsupportedReason,
) {
  return {
    id,
    status,
    reason_code: status === 'available' ? undefined : (reasonCode ?? 'not_probed'),
    reason: status === 'available' ? undefined : (reason ?? 'not measured'),
  };
}

const REGISTERED_IMPLEMENTATION_PATHS = [
  'filesystem.access',
  'filesystem.composition',
  'network',
  'process.linux_namespaces',
  'resource.cgroup_v2',
  'syscall.seccomp',
];

interface ImplementationState {
  status?: SandboxImplementationStatus;
  options?: ReturnType<typeof optionEntry>[];
  fields?: ReturnType<typeof fieldEntry>[];
  reasonCode?: SandboxUnsupportedReason;
  reason?: string;
}

function implementationEntry(
  path: string,
  state: ImplementationState = {},
): ReturnType<typeof importImplementation> {
  return importImplementation(path, state);
}

function importImplementation(path: string, state: ImplementationState) {
  const status = state.status ?? 'available';
  return {
    path,
    status,
    reason_code: status === 'available' ? undefined : (state.reasonCode ?? 'not_probed'),
    reason: status === 'available' ? undefined : (state.reason ?? 'not measured'),
    options: state.options ?? [],
    fields: state.fields ?? [],
  };
}

function registeredUnknownImplementations(reason: string) {
  return REGISTERED_IMPLEMENTATION_PATHS.map((path) =>
    implementationEntry(path, {
      status: 'unknown',
      reasonCode: 'not_probed',
      reason,
    }),
  );
}

function unsupportedCatalog(): SandboxCapabilityCatalog {
  const reason = 'bubblewrap is not executable on this host';
  return {
    catalog_version: 2,
    status: 'unavailable',
    platform: 'linux',
    backend: undefined,
    probe_generation: 'fixture-probe-unsupported',
    source: 'agent-host-probe',
    detail: [reason],
    reason,
    implementations: REGISTERED_IMPLEMENTATION_PATHS.map((path) =>
      implementationEntry(path, {
        status: 'unavailable',
        reasonCode: 'backend_missing',
        reason,
      }),
    ),
    resource_fields: [],
    syscall_fields: [],
  };
}

function macosCatalog(): SandboxCapabilityCatalog {
  const platformReason = 'this implementation is Linux-native and is not built for macOS Seatbelt';
  return {
    catalog_version: 2,
    status: 'available',
    platform: 'macos',
    backend: 'macos-seatbelt',
    probe_generation: 'fixture-probe-macos',
    source: 'agent-host-probe',
    detail: [
      'Seatbelt network denial verified',
      'filesystem path allow-lists are not verified on macOS',
    ],
    implementations: [
      implementationEntry('filesystem.access', {
        status: 'unavailable',
        reasonCode: 'kernel_feature_missing',
        reason: 'filesystem access could not be verified under macOS Seatbelt',
      }),
      implementationEntry('filesystem.composition', {
        status: 'unavailable',
        reasonCode: 'platform_unsupported',
        reason: platformReason,
      }),
      implementationEntry('network', {
        options: [
          optionEntry('allow'),
          optionEntry('deny'),
          optionEntry(
            'restricted',
            'unavailable',
            'network.mode restricted is not supported by the macOS backend in V1',
            'platform_unsupported',
          ),
        ],
      }),
      implementationEntry('process.linux_namespaces', {
        status: 'unavailable',
        reasonCode: 'platform_unsupported',
        reason: platformReason,
      }),
      implementationEntry('resource.cgroup_v2', {
        status: 'unavailable',
        reasonCode: 'platform_unsupported',
        reason: platformReason,
      }),
      implementationEntry('syscall.seccomp', {
        status: 'unavailable',
        reasonCode: 'platform_unsupported',
        reason: platformReason,
      }),
    ],
    resource_fields: [],
    syscall_fields: [],
  };
}

function offlineCatalog(): SandboxCapabilityCatalog {
  const reason = 'the Agent did not answer';
  return {
    catalog_version: 2,
    status: 'unknown',
    platform: 'unknown',
    backend: undefined,
    probe_generation: '',
    source: 'unavailable',
    detail: [],
    reason,
    implementations: registeredUnknownImplementations(reason),
    resource_fields: [],
    syscall_fields: [],
  };
}

function linuxCatalog(limited: boolean): SandboxCapabilityCatalog {
  // Discovery-shaped catalog (#3141): actual delegated controller files with
  // their currently read values as hints. This is not a four-key allowlist;
  // `cpu.weight`, `memory.high` and `io.max` are beyond the retired V1 set.
  const resourceFields = [
    fieldEntry({
      key: 'memory.max',
      controller: 'memory',
      valueFormat: 'native cgroup v2 control-file text',
      example: 'max',
    }),
    fieldEntry({
      key: 'memory.high',
      controller: 'memory',
      valueFormat: 'native cgroup v2 control-file text',
      example: 'max',
    }),
    fieldEntry({
      key: 'memory.oom.group',
      controller: 'memory',
      valueFormat: 'native cgroup v2 control-file text',
      example: '0',
    }),
    fieldEntry({
      key: 'cpu.max',
      controller: 'cpu',
      valueFormat: 'native cgroup v2 control-file text',
      example: 'max 100000',
      available: !limited,
      reasonCode: 'controller_not_delegated',
      reason: 'the cpu controller is not delegated to this Agent’s execution root',
    }),
    fieldEntry({
      key: 'cpu.weight',
      controller: 'cpu',
      valueFormat: 'native cgroup v2 control-file text',
      example: '100',
      available: !limited,
      reasonCode: 'controller_not_delegated',
      reason: 'the cpu controller is not delegated to this Agent’s execution root',
    }),
    fieldEntry({
      key: 'pids.max',
      controller: 'pids',
      valueFormat: 'native cgroup v2 control-file text',
      example: 'max',
    }),
    ...(limited
      ? []
      : [
          fieldEntry({
            key: 'io.max',
            controller: 'io',
            valueFormat: 'native cgroup v2 control-file text',
            example: '8:16 rbps=max',
          }),
        ]),
  ];
  return {
    catalog_version: 2,
    status: 'available',
    platform: 'linux',
    backend: 'linux-bwrap',
    probe_generation: limited ? 'fixture-probe-limited' : 'fixture-probe-full',
    source: 'agent-host-probe',
    detail: limited
      ? ['delegated controllers: memory, pids']
      : ['delegated controllers: memory, cpu, pids'],
    implementations: [
      implementationEntry('filesystem.access'),
      implementationEntry('filesystem.composition', {
        options: [optionEntry('workspace_image')],
      }),
      implementationEntry('network', {
        options: [optionEntry('allow'), optionEntry('deny'), optionEntry('restricted')],
      }),
      implementationEntry('process.linux_namespaces', {
        options: ['pid', 'ipc', 'user', 'uts', 'cgroup'].map((name) => optionEntry(name)),
      }),
      implementationEntry('resource.cgroup_v2', { fields: resourceFields }),
      implementationEntry('syscall.seccomp', {
        options: [optionEntry('nession-interactive-v1')],
      }),
    ],
    resource_fields: resourceFields,
    syscall_fields: [
      fieldEntry({
        key: 'seccomp.profile',
        valueFormat: 'registered Agent seccomp profile',
        example: 'nession-interactive-v1',
      }),
    ],
  };
}

function catalogFor(scenario: Scenario): SandboxCapabilityCatalog {
  if (scenario === 'unsupported') {
    return unsupportedCatalog();
  }
  if (scenario === 'macos') {
    return macosCatalog();
  }
  if (scenario === 'offline') {
    return offlineCatalog();
  }
  return linuxCatalog(scenario === 'limited');
}

function effectivePolicy(): SandboxPolicyDraft {
  return {
    version: 1,
    enabled: true,
    filesystem: { access: { read: ['/usr', '/bin'], write: ['/workspace'] } },
    network: { mode: 'deny', ingress: 'deny' },
    process: {
      linux_namespaces: { pid: true, ipc: true, user: true, uts: true, cgroup: false },
    },
    resource: [
      { key: 'memory.max', value: '2147483648' },
      { key: 'cpu.weight', value: '100' },
      { key: 'memory.high', value: '1073741824' },
    ],
    syscall: [{ key: 'seccomp.profile', value: 'nession-interactive-v1' }],
    enforcement: 'required',
  };
}

function outsideContext(scenario: Scenario, revision: number): SandboxCurrentContext {
  const catalog = catalogFor(scenario);
  const unknown = scenario === 'unknown';
  const unsupported = scenario === 'unsupported';
  return {
    status: unknown ? 'unknown' : 'outside',
    reason: unknown
      ? 'the Session’s instance identity changed; a previous execution’s report is not this Pane’s proof'
      : unsupported
        ? catalog.reason
        : undefined,
    scope: {
      session_name: SESSION,
      session_instance_id: unknown ? undefined : INSTANCE,
      pane_id: '%1',
      window_id: '@1',
      pane_pid: 4242,
      working_dir: '/workspace',
    },
    generation: `fixture-${scenario}-${revision}`,
    execution: undefined,
    effective_policy: undefined,
    native_pane: undefined,
    enterable: !unknown && !unsupported,
    sandbox_panes: [],
    catalog,
  };
}

function insideContext(scenario: Scenario, revision: number): SandboxCurrentContext {
  const catalog = catalogFor(scenario);
  return {
    status: 'inside',
    scope: {
      session_name: SESSION,
      session_instance_id: INSTANCE,
      pane_id: '%2',
      window_id: '@2',
      pane_pid: 4343,
      working_dir: '/workspace',
    },
    generation: `fixture-inside-${revision}`,
    execution: {
      execution_id: 'fixture-execution-1',
      backend: 'linux-bwrap',
      policy_digest: 'a'.repeat(64),
      mechanisms: [
        scenario === 'inside-erofs' ? 'filesystem.erofs' : 'filesystem.access',
        'network.deny',
        'process.linux_namespaces.pid,ipc,user,uts',
        'resource.cgroup_v2',
        'syscall.seccomp',
        'backend.baseline_namespaces',
      ],
      cgroup_path: '/nession/fixture-execution-1',
      warnings: ['backend baseline mounts added for executability'],
      pane_pid: 4343,
      created_at: 1_760_000_000,
    },
    effective_policy: effectivePolicy(),
    native_pane: { window_id: '@1', pane_id: '%1' },
    enterable: false,
    sandbox_panes: [
      {
        execution_id: 'fixture-execution-1',
        window_id: '@2',
        pane_id: '%2',
        backend: 'linux-bwrap',
      },
    ],
    catalog,
  };
}

// Fixture mirror of the Agent's generic native cgroup basename rule (#3141).
// It is deliberately not a resource allowlist and never validates a value's
// kernel format; the real sandbox owner remains authoritative.
const RESOURCE_READ_ONLY_SUFFIXES = [
  '.stat',
  '.stat.local',
  '.events',
  '.events.local',
  '.current',
  '.peak',
  '.pressure',
  '.numa_stat',
  '.effective',
];

function resourceKeyError(key: string): string | null {
  if (!key) {
    return 'a native cgroup control-file name is required';
  }
  if (key.trim() !== key) {
    return `\`${key}\` must not have surrounding whitespace`;
  }
  if (key.includes('/') || key.includes('\\') || key.includes('\u0000')) {
    return `\`${key}\` must be one control-file basename with no path separators`;
  }
  if (key === '.' || key === '..' || key.includes('..')) {
    return `\`${key}\` must be a plain control-file basename`;
  }
  if (key.startsWith('cgroup.')) {
    return `\`${key}\` is a cgroup hierarchy/lifecycle interface, not a declarative resource control`;
  }
  if (RESOURCE_READ_ONLY_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
    return `\`${key}\` is a read-only cgroup status/interface file`;
  }
  if (key === 'memory.reclaim') {
    return `\`${key}\` is a command-style cgroup interface, not declarative configuration`;
  }
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(key)) {
    return `\`${key}\` is not a native resource-controller control-file basename`;
  }
  return null;
}

function validateRows(rows: SandboxKvEntry[], group: 'resource' | 'syscall'): SandboxFieldError[] {
  const errors: SandboxFieldError[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key) {
      errors.push({
        field: `${group}[${index}].key`,
        code: 'blank-key',
        message: 'a key is required',
      });
      return;
    }
    if (group === 'resource') {
      const keyError = resourceKeyError(key);
      if (keyError) {
        errors.push({
          field: `${group}[${index}].key`,
          code: 'invalid-key',
          message: keyError,
        });
        return;
      }
    }
    if (group === 'syscall' && key !== 'seccomp.profile') {
      errors.push({
        field: `${group}[${index}].key`,
        code: 'unknown-key',
        message: `\`${key}\` is not supported; the only V1 key is \`seccomp.profile\``,
      });
      return;
    }
    if (seen.has(key)) {
      errors.push({
        field: `${group}[${index}].key`,
        code: 'duplicate-key',
        message: `\`${key}\` is already configured`,
      });
      return;
    }
    seen.add(key);
    if (!value) {
      errors.push({
        field: `${group}[${index}].value`,
        code: 'blank-value',
        message: 'a native value is required',
      });
      return;
    }
    if (group === 'syscall' && value !== 'nession-interactive-v1') {
      errors.push({
        field: `${group}[${index}].value`,
        code: 'invalid-value',
        message: 'this build pins `nession-interactive-v1`',
      });
      return;
    }
    // Resource values are native kernel text: the Agent writes them verbatim
    // and the kernel is the only format/range authority (#3141).
  });
  return errors;
}

function preflight(
  scenario: Scenario,
  payload: Record<string, unknown>,
): SandboxPreflightResult {
  const policy = payload.policy as SandboxPolicyDraft;
  const generation = String(payload.generation ?? '');
  const catalog = catalogFor(scenario);
  const errors = [
    ...validateRows(policy.resource ?? [], 'resource'),
    ...validateRows(policy.syscall ?? [], 'syscall'),
  ];
  const filesystem = policy.filesystem?.access;
  for (const path of [...(filesystem?.read ?? []), ...(filesystem?.write ?? [])]) {
    if (!path.startsWith('/')) {
      errors.push({
        field: 'filesystem.access.read',
        code: 'invalid-value',
        message: `filesystem path \`${path}\` must be absolute`,
      });
      break;
    }
  }
  if (scenario === 'limited') {
    const cpu = (policy.resource ?? []).find((row) => row.key.trim().startsWith('cpu.'));
    if (cpu) {
      errors.push({
        field: 'resource[0].key',
        code: 'unsupported',
        message: `resource.cgroup_v2 ${cpu.key.trim()} is not installable: the cpu controller is not delegated`,
      });
    }
  }
  if (scenario === 'macos') {
    if ((policy.resource ?? []).length > 0 || (policy.syscall ?? []).length > 0) {
      errors.push({
        field: 'policy',
        code: 'unsupported',
        message: 'resource.cgroup_v2 and syscall.seccomp are Linux-native and unsupported on macOS',
      });
    }
  }
  if (scenario === 'preflight-fail') {
    errors.push({
      field: 'policy',
      code: 'unsupported',
      message: 'resource.cgroup_v2 controllers are not delegated: memory',
    });
  }
  if (errors.length > 0) {
    return {
      ok: false,
      generation,
      mechanisms: [],
      errors,
      warnings: [],
      catalog,
    };
  }
  return {
    ok: true,
    generation,
    policy_digest: 'b'.repeat(64),
    backend: scenario === 'macos' ? 'macos-seatbelt' : 'linux-bwrap',
    mechanisms: ['network.deny'],
    errors: [],
    warnings: [],
    catalog,
  };
}

function fixtureCacheStatuses(
  cacheDigests: string[],
  failed: boolean,
): SandboxContextResponse['cache_statuses'] {
  return cacheDigests.map((digest) => ({
    digest,
    state: failed ? ('failed' as const) : ('verified' as const),
    ...(failed ? { detail: 'fixture cache verification failed' } : {}),
  }));
}

function fixtureCacheObservations(
  cacheDigests: string[],
  scenario: Scenario,
): SandboxContextResponse['cache_observations'] {
  return cacheDigests.map((digest, index) => {
    if (scenario === 'agent-cache-failed') {
      return {
        contract_version: 1,
        digest,
        phase: 'failed' as const,
        downloaded_bytes: 262_144,
        total_bytes: 4_194_304,
        active: false,
        updated_at: 1_760_000_000,
        detail: 'fixture cache verification failed',
      };
    }
    if (scenario === 'agent-cache-downloading' && index === 0) {
      return {
        contract_version: 1,
        digest,
        phase: 'downloading' as const,
        downloaded_bytes: 1_048_576,
        total_bytes: 4_194_304,
        active: true,
        updated_at: 1_760_000_100,
      };
    }
    if (scenario === 'agent-cache-resumable' && index === 0) {
      return {
        contract_version: 1,
        digest,
        phase: 'resumable' as const,
        downloaded_bytes: 524_288,
        total_bytes: 4_194_304,
        active: false,
        updated_at: 1_760_000_200,
        detail: 'a verified partial download survives; resume on next Prepare',
      };
    }
    return {
      contract_version: 1,
      digest,
      phase: 'verified' as const,
      downloaded_bytes: 4_194_304,
      total_bytes: 4_194_304,
      active: false,
      updated_at: 1_760_000_000,
    };
  });
}

interface FixtureSandboxState {
  scenario: Scenario;
  revision: number;
  entered: boolean;
}

/** The one request switch; `state` is the Agent's mutable observed state. */
function answerSandbox(
  state: FixtureSandboxState,
  type: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const contextFor = (): SandboxCurrentContext =>
    state.entered
      ? insideContext(state.scenario, state.revision)
      : outsideContext(state.scenario, state.revision);
  if (type === CONTEXT_WIRE) {
    if (state.scenario === 'offline') {
      return Promise.reject(new Error('Agent did not answer'));
    }
    const cacheDigests = Array.isArray(payload.cache_digests)
      ? payload.cache_digests.filter((digest): digest is string => typeof digest === 'string')
      : [];
    const response: SandboxContextResponse = {
      success: true,
      context: contextFor(),
      cache_statuses: fixtureCacheStatuses(
        cacheDigests,
        state.scenario === 'agent-cache-failed',
      ),
      cache_observations: fixtureCacheObservations(cacheDigests, state.scenario),
    };
    return Promise.resolve(response);
  }
  if (type === PREFLIGHT_WIRE) {
    const context = contextFor();
    if (String(payload.generation ?? '') !== context.generation) {
      return Promise.resolve({
        ok: false,
        error: 'the Sandbox context changed since the draft was composed; re-read it',
        generation: context.generation,
        mechanisms: [],
        errors: [
          {
            field: 'context',
            code: 'stale-generation',
            message: 'the Sandbox context changed since the draft was composed',
          },
        ],
        warnings: [],
        catalog: context.catalog,
      } satisfies SandboxPreflightResult);
    }
    return Promise.resolve(preflight(state.scenario, payload));
  }
  if (type === ENTER_WIRE) {
    const context = contextFor();
    if (String(payload.generation ?? '') !== context.generation) {
      return Promise.resolve({
        success: false,
        error_kind: 'conflict',
        error: 'the Sandbox context changed since preflight; re-run it',
        context,
      } satisfies SandboxActionResult);
    }
    if (state.entered) {
      return Promise.resolve({
        success: false,
        error_kind: 'conflict',
        error: 'the active Pane is already inside a managed Sandbox',
        context,
      } satisfies SandboxActionResult);
    }
    if (state.scenario === 'enter-fail') {
      return Promise.resolve({
        success: false,
        error_kind: 'failed',
        error:
          'sandbox launch failed: write cpu.weight in the execution cgroup: Invalid argument (os error 22)',
        context,
      } satisfies SandboxActionResult);
    }
    state.revision += 1;
    state.entered = true;
    return Promise.resolve({
      success: true,
      context: insideContext(state.scenario, state.revision),
    } satisfies SandboxActionResult);
  }
  if (type === RETURN_WIRE) {
    if (!state.entered) {
      return Promise.resolve({
        success: false,
        error_kind: 'conflict',
        error: 'the active Pane is not inside a managed Sandbox',
        context: contextFor(),
      } satisfies SandboxActionResult);
    }
    state.revision += 1;
    state.entered = false;
    const context = outsideContext(state.scenario, state.revision);
    context.sandbox_panes = [
      {
        execution_id: 'fixture-execution-1',
        window_id: '@2',
        pane_id: '%2',
        backend: 'linux-bwrap',
      },
    ];
    return Promise.resolve({ success: true, context } satisfies SandboxActionResult);
  }
  if (type === FOCUS_WIRE) {
    state.revision += 1;
    state.entered = true;
    return Promise.resolve({
      success: true,
      context: insideContext(state.scenario, state.revision),
    } satisfies SandboxActionResult);
  }
  return Promise.reject(new Error(`fixture sandbox surface does not answer ${type}`));
}

export function fixtureSandboxSurface(search: string): PluginSurface {
  const state: FixtureSandboxState = {
    scenario: scenarioOf(search),
    revision: 0,
    entered:
      scenarioOf(search) === 'inside' || scenarioOf(search) === 'inside-erofs',
  };
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));
  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      return answerSandbox(state, type, payload) as Promise<T>;
    },
    send(): void {},
    subscribe(): () => void {
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(): () => void {
      return () => {};
    },
  };
}
