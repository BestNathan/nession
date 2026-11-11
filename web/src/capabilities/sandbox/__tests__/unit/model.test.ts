import { describe, expect, it } from 'vitest';
import type {
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
  SandboxFieldEntry,
  SandboxImplementationStatus,
  SandboxImplementationSupport,
  SandboxPolicyDraft,
  SandboxPreflightResult,
  SandboxUnsupportedReason,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  addKvRow,
  catalogOptions,
  draftForContext,
  draftSignature,
  emptySandboxDraft,
  entriesToLines,
  fieldErrorsByField,
  filesystemDisabledReason,
  implementationSupport,
  linesToEntries,
  namespaceDisabledReason,
  networkModeDisabledReason,
  optionAvailable,
  preflightIsValid,
  removeKvRow,
  resourceDisabledReason,
  syscallDisabledReason,
  updateKvRow,
} from '../../model';

const RESOURCE_FIELDS: SandboxFieldEntry[] = [
  {
    key: 'cpu.max',
    controller: 'cpu',
    value_format: '`quota period`',
    example: '200000 100000',
    available: true,
  },
];
const SYSCALL_FIELDS: SandboxFieldEntry[] = [
  {
    key: 'seccomp.profile',
    value_format: 'profile',
    example: 'nession-interactive-v1',
    available: true,
  },
];

interface ImplementationState {
  status?: SandboxImplementationStatus;
  options?: SandboxImplementationSupport['options'];
  fields?: SandboxFieldEntry[];
  reasonCode?: SandboxUnsupportedReason;
  reason?: string;
}

function implementation(
  path: string,
  state: ImplementationState = {},
): SandboxImplementationSupport {
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

function linuxImplementations(overrides: SandboxImplementationSupport[] = []) {
  const defaults = [
    implementation('filesystem.access'),
    implementation('filesystem.composition', {
      options: [{ id: 'workspace_image', status: 'available' }],
    }),
    implementation('network', {
      options: [
        { id: 'allow', status: 'available' },
        { id: 'deny', status: 'available' },
        { id: 'restricted', status: 'available' },
      ],
    }),
    implementation('process.linux_namespaces', {
      options: ['pid', 'ipc', 'user', 'uts', 'cgroup'].map((id) => ({
        id,
        status: 'available' as const,
      })),
    }),
    implementation('resource.cgroup_v2', { fields: RESOURCE_FIELDS }),
    implementation('syscall.seccomp', {
      options: [{ id: 'nession-interactive-v1', status: 'available' }],
    }),
  ];
  return [...overrides, ...defaults.filter((entry) => !overrides.some((o) => o.path === entry.path))];
}

function catalog(overrides: Partial<SandboxCapabilityCatalog> = {}): SandboxCapabilityCatalog {
  return {
    catalog_version: 2,
    status: 'available',
    platform: 'linux',
    backend: 'linux-bwrap',
    probe_generation: 'probe-1',
    source: 'agent-host-probe',
    detail: [],
    implementations: linuxImplementations(),
    resource_fields: RESOURCE_FIELDS,
    syscall_fields: SYSCALL_FIELDS,
    ...overrides,
  };
}

function macosCatalog(): SandboxCapabilityCatalog {
  const platformReason = 'Linux-native and not built for macOS Seatbelt';
  return catalog({
    platform: 'macos',
    backend: 'macos-seatbelt',
    implementations: [
      implementation('filesystem.access', {
        status: 'unavailable',
        reasonCode: 'kernel_feature_missing',
        reason: 'filesystem access could not be verified under macOS Seatbelt',
      }),
      implementation('filesystem.composition', {
        status: 'unavailable',
        reasonCode: 'platform_unsupported',
        reason: platformReason,
      }),
      implementation('network', {
        options: [
          { id: 'allow', status: 'available' },
          { id: 'deny', status: 'available' },
          {
            id: 'restricted',
            status: 'unavailable',
            reason_code: 'platform_unsupported',
            reason: 'restricted is not supported by the macOS backend',
          },
        ],
      }),
      implementation('process.linux_namespaces', {
        status: 'unavailable',
        reasonCode: 'platform_unsupported',
        reason: platformReason,
      }),
      implementation('resource.cgroup_v2', {
        status: 'unavailable',
        reasonCode: 'platform_unsupported',
        reason: platformReason,
      }),
      implementation('syscall.seccomp', {
        status: 'unavailable',
        reasonCode: 'platform_unsupported',
        reason: platformReason,
      }),
    ],
    resource_fields: [],
    syscall_fields: [],
  });
}

function preflight(ok: boolean, generation = 'gen-1'): {
  signature: string;
  result: SandboxPreflightResult;
} {
  return {
    signature: 'signature-1',
    result: {
      ok,
      generation,
      mechanisms: [],
      errors: [],
      warnings: [],
      catalog: catalog(),
    },
  };
}

function insideContext(policy: SandboxPolicyDraft): SandboxCurrentContext {
  return {
    status: 'inside',
    scope: { session_name: 'dev' },
    generation: 'gen-inside',
    effective_policy: policy,
    enterable: false,
    sandbox_panes: [],
    catalog: catalog(),
  };
}

describe('Sandbox capability model (#3124, #3161)', () => {
  it('starts every optional group empty', () => {
    const draft = emptySandboxDraft();
    expect(draft.enabled).toBe(true);
    expect(draft.filesystem).toBeUndefined();
    expect(draft.process).toBeUndefined();
    expect(draft.resource).toEqual([]);
    expect(draft.syscall).toEqual([]);
    expect(draft.network).toEqual({ mode: 'allow', ingress: 'deny' });
    expect(draft.enforcement).toBe('required');
  });

  it('projects the observed effective policy without aliasing it', () => {
    const policy: SandboxPolicyDraft = {
      version: 1,
      enabled: true,
      filesystem: { access: { read: ['/usr'], write: ['/workspace'] } },
      network: { mode: 'deny', ingress: 'deny' },
      process: { linux_namespaces: { pid: true, ipc: true, user: true, uts: true, cgroup: false } },
      resource: [{ key: 'cpu.max', value: '200000 100000' }],
      syscall: [{ key: 'seccomp.profile', value: 'nession-interactive-v1' }],
      enforcement: 'required',
    };
    const draft = draftForContext(insideContext(policy));
    expect(draft).toEqual(policy);
    expect(draft).not.toBe(policy);
    draft.resource[0].value = 'changed';
    expect(policy.resource[0].value).toBe('200000 100000');
    expect(draftForContext(null)).toEqual(emptySandboxDraft());
  });

  it('adds, edits and removes Key/Value rows without changing the rest', () => {
    let rows = addKvRow([]);
    expect(rows).toEqual([{ key: '', value: '' }]);
    rows = updateKvRow(rows, 0, { key: 'memory.max', value: '1024' });
    expect(rows[0]).toEqual({ key: 'memory.max', value: '1024' });
    rows = addKvRow(rows);
    rows = updateKvRow(rows, 1, { key: 'pids.max' });
    expect(removeKvRow(rows, 0)).toEqual([{ key: 'pids.max', value: '' }]);
  });

  it('treats one non-empty line per path and drops blank lines', () => {
    expect(linesToEntries(' /usr \n\n/workspace\n')).toEqual(['/usr', '/workspace']);
    expect(entriesToLines(['/usr', '/workspace'])).toBe('/usr\n/workspace');
  });

  it('invalidates a preflight when the draft, context or probe generation changes', () => {
    expect(preflightIsValid(preflight(true), 'signature-1', 'gen-1', 'probe-1')).toBe(true);
    expect(preflightIsValid(preflight(false), 'signature-1', 'gen-1', 'probe-1')).toBe(false);
    expect(preflightIsValid(preflight(true), 'signature-2', 'gen-1', 'probe-1')).toBe(false);
    expect(preflightIsValid(preflight(true), 'signature-1', 'gen-2', 'probe-1')).toBe(false);
    expect(preflightIsValid(preflight(true), 'signature-1', 'gen-1', 'probe-2')).toBe(false);
    expect(preflightIsValid(null, 'signature-1', 'gen-1', 'probe-1')).toBe(false);
    // The signature is stable for the same draft and changes on any edit.
    const base = emptySandboxDraft();
    expect(draftSignature(base)).toBe(draftSignature(emptySandboxDraft()));
    expect(draftSignature({ ...base, resource: addKvRow(base.resource) })).not.toBe(
      draftSignature(base),
    );
  });

  it('uses the Agent implementation catalog for choices and explains unavailable groups', () => {
    expect(catalogOptions(catalog(), 'resource').map((field) => field.key)).toEqual(['cpu.max']);
    expect(catalogOptions(undefined, 'resource')).toEqual([]);
    expect(resourceDisabledReason(catalog())).toBeNull();
    expect(syscallDisabledReason(catalog())).toBeNull();
    expect(filesystemDisabledReason(catalog())).toBeNull();

    const macos = macosCatalog();
    expect(resourceDisabledReason(macos)).toContain('Linux-native');
    expect(syscallDisabledReason(macos)).toContain('Linux-native');
    expect(filesystemDisabledReason(macos)).toContain('Seatbelt');

    const unavailable = catalog({
      status: 'unavailable',
      reason: 'bubblewrap missing',
      implementations: linuxImplementations().map((entry) =>
        implementation(entry.path, {
          status: 'unavailable',
          reasonCode: 'backend_missing',
          reason: 'bubblewrap missing',
        }),
      ),
    });
    expect(resourceDisabledReason(unavailable)).toBe('bubblewrap missing');
    expect(syscallDisabledReason(unavailable)).toBe('bubblewrap missing');

    const empty = catalog({
      resource_fields: [],
      syscall_fields: [],
      implementations: linuxImplementations([
        implementation('resource.cgroup_v2'),
        implementation('syscall.seccomp'),
      ]),
    });
    expect(resourceDisabledReason(empty)).toContain('no installable');
    expect(syscallDisabledReason(empty)).toContain('no loadable');

    const legacy = catalog({ catalog_version: 0, implementations: [] });
    expect(implementationSupport(legacy, 'network')).toBeUndefined();
    expect(resourceDisabledReason(legacy)).toContain('did not report per-implementation support');
  });

  it('disables individual unavailable modes, namespaces and fields', () => {
    const partial = catalog({
      implementations: linuxImplementations([
        implementation('network', {
          options: [
            { id: 'allow', status: 'available' },
            { id: 'deny', status: 'available' },
            {
              id: 'restricted',
              status: 'unavailable',
              reason_code: 'kernel_feature_missing',
              reason: 'the in-sandbox bridge is not built',
            },
          ],
        }),
        implementation('process.linux_namespaces', {
          options: [
            { id: 'pid', status: 'unavailable', reason_code: 'kernel_feature_missing', reason: 'no pidns' },
            { id: 'ipc', status: 'available' },
            { id: 'user', status: 'available' },
            { id: 'uts', status: 'available' },
            { id: 'cgroup', status: 'available' },
          ],
        }),
        implementation('resource.cgroup_v2', {
          fields: [
            {
              key: 'cpu.max',
              controller: 'cpu',
              value_format: '`quota period`',
              example: '200000 100000',
              available: false,
              reason_code: 'controller_not_delegated',
              reason: 'cpu is not delegated',
            },
          ],
        }),
      ]),
    });
    expect(optionAvailable(partial, 'network', 'allow')).toBe(true);
    expect(optionAvailable(partial, 'network', 'restricted')).toBe(false);
    expect(networkModeDisabledReason(partial, 'restricted')).toContain('bridge');
    expect(networkModeDisabledReason(partial, 'deny')).toBeNull();
    expect(namespaceDisabledReason(partial, 'pid')).toContain('pidns');
    expect(namespaceDisabledReason(partial, 'ipc')).toBeNull();
    expect(implementationSupport(partial, 'resource.cgroup_v2')?.fields?.[0].available).toBe(
      false,
    );
  });

  it('keys field errors by their wire field path', () => {
    expect(
      fieldErrorsByField([
        { field: 'resource[0].key', code: 'unknown-key', message: 'unknown' },
        { field: 'resource[0].value', code: 'invalid-value', message: 'bad value' },
      ]),
    ).toEqual({
      'resource[0].key': 'unknown',
      'resource[0].value': 'bad value',
    });
    expect(fieldErrorsByField(undefined)).toEqual({});
  });
});
