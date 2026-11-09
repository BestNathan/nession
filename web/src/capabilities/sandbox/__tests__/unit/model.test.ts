import { describe, expect, it } from 'vitest';
import type {
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
  SandboxPolicyDraft,
  SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  addKvRow,
  catalogOptions,
  draftForContext,
  draftSignature,
  emptySandboxDraft,
  entriesToLines,
  fieldErrorsByField,
  linesToEntries,
  preflightIsValid,
  removeKvRow,
  resourceDisabledReason,
  syscallDisabledReason,
  updateKvRow,
} from '../../model';

function catalog(overrides: Partial<SandboxCapabilityCatalog> = {}): SandboxCapabilityCatalog {
  return {
    status: 'available',
    platform: 'linux',
    backend: 'linux-bwrap',
    probe_generation: 'probe-1',
    source: 'agent-host-probe',
    detail: [],
    resource_fields: [
      { key: 'cpu.max', value_format: '`quota period`', example: '200000 100000', available: true },
    ],
    syscall_fields: [
      {
        key: 'seccomp.profile',
        value_format: 'profile',
        example: 'nession-interactive-v1',
        available: true,
      },
    ],
    ...overrides,
  };
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

describe('Sandbox capability model (#3124)', () => {
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

  it('invalidates a preflight when the draft or the context generation changes', () => {
    expect(preflightIsValid(preflight(true), 'signature-1', 'gen-1')).toBe(true);
    expect(preflightIsValid(preflight(false), 'signature-1', 'gen-1')).toBe(false);
    expect(preflightIsValid(preflight(true), 'signature-2', 'gen-1')).toBe(false);
    expect(preflightIsValid(preflight(true), 'signature-1', 'gen-2')).toBe(false);
    expect(preflightIsValid(null, 'signature-1', 'gen-1')).toBe(false);
    // The signature is stable for the same draft and changes on any edit.
    const base = emptySandboxDraft();
    expect(draftSignature(base)).toBe(draftSignature(emptySandboxDraft()));
    expect(draftSignature({ ...base, resource: addKvRow(base.resource) })).not.toBe(
      draftSignature(base),
    );
  });

  it('uses the Agent catalog for choices and explains unavailable groups', () => {
    expect(catalogOptions(catalog(), 'resource').map((field) => field.key)).toEqual(['cpu.max']);
    expect(catalogOptions(undefined, 'resource')).toEqual([]);
    expect(resourceDisabledReason(catalog())).toBeNull();
    expect(syscallDisabledReason(catalog())).toBeNull();

    const macos = catalog({ platform: 'macos', backend: 'macos-seatbelt', resource_fields: [] });
    expect(resourceDisabledReason(macos)).toContain('macOS');
    expect(syscallDisabledReason(macos)).toContain('macOS');

    const unavailable = catalog({ status: 'unavailable', reason: 'bubblewrap missing' });
    expect(resourceDisabledReason(unavailable)).toBe('bubblewrap missing');
    expect(syscallDisabledReason(unavailable)).toBe('bubblewrap missing');

    const empty = catalog({ resource_fields: [], syscall_fields: [] });
    expect(resourceDisabledReason(empty)).toContain('no installable');
    expect(syscallDisabledReason(empty)).toContain('no loadable');
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
