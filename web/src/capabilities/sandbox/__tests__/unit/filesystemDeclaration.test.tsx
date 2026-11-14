import { describe, expect, it } from 'vitest';
import type {
  SandboxCurrentContext,
  SandboxPolicyDraft,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  accessConflictsWithDeclaration,
  declaredDigests,
  draftForContext,
  formatBytes,
  mountTargetError,
  observationPhaseLabel,
  transferLabel,
} from '../../model';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const TOOL_DIGEST = `sha256:${'b'.repeat(64)}`;

function policy(filesystem: SandboxPolicyDraft['filesystem']): SandboxPolicyDraft {
  return {
    version: 1,
    enabled: true,
    filesystem,
    network: { mode: 'allow', ingress: 'deny' },
    resource: [],
    syscall: [],
    enforcement: 'required',
  };
}

function contextWith(declaration: SandboxPolicyDraft): SandboxCurrentContext {
  return {
    status: 'outside',
    scope: {
      session_name: 's1',
      session_instance_id: 'instance-1',
      pane_id: '%1',
      window_id: '@1',
      pane_pid: 42,
      working_dir: '/workspace',
    },
    generation: 'gen-1',
    enterable: true,
    sandbox_panes: [],
    catalog: {
      catalog_version: 2,
      status: 'available',
      platform: 'linux',
      backend: 'linux-bwrap',
      probe_generation: 'probe-1',
      source: 'agent-host-probe',
      detail: [],
      implementations: [],
      resource_fields: [],
      syscall_fields: [],
    },
    effective_policy: declaration,
  };
}

describe('Filesystem declaration model', () => {
  it('collects the declared RootFS and mount digests without duplicates', () => {
    const draft = policy({
      access: { read: [], write: [] },
      rootfs: { kind: 'image', digest: DIGEST },
      mounts: [
        {
          source: { kind: 'image', digest: TOOL_DIGEST },
          target: '/opt/rust',
          read_only: true,
        },
        {
          source: { kind: 'image', digest: TOOL_DIGEST },
          target: '/opt/go',
          read_only: true,
        },
      ],
    });
    expect(declaredDigests(draft)).toEqual([DIGEST, TOOL_DIGEST]);
  });

  it('mirrors the /opt/<lowercase-name> mount target rule', () => {
    expect(mountTargetError('/opt/rust')).toBeNull();
    expect(mountTargetError('/opt/rust-1.2_x')).toBeNull();
    expect(mountTargetError('/opt/Rust')).not.toBeNull();
    expect(mountTargetError('/opt/')).not.toBeNull();
    expect(mountTargetError('/opt/../escape')).not.toBeNull();
    expect(mountTargetError('/usr')).not.toBeNull();
  });

  it('only treats an image declaration as conflicting with access', () => {
    expect(
      accessConflictsWithDeclaration({
        access: { read: ['/usr'], write: [] },
        rootfs: { kind: 'image', digest: DIGEST },
      }),
    ).toBe(true);
    expect(
      accessConflictsWithDeclaration({
        access: { read: ['/usr'], write: [] },
        rootfs: { kind: 'local' },
      }),
    ).toBe(false);
    expect(
      accessConflictsWithDeclaration({
        access: { read: [], write: [] },
        rootfs: { kind: 'image', digest: DIGEST },
      }),
    ).toBe(false);
  });

  it('formats measured phases and bytes honestly', () => {
    expect(observationPhaseLabel('resumable')).toBe('Resumable partial');
    expect(observationPhaseLabel('verifying')).toBe('Verifying');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(4_194_304)).toBe('4.0 MiB');
    expect(
      transferLabel({
        contract_version: 1,
        digest: DIGEST,
        phase: 'downloading',
        downloaded_bytes: 1_048_576,
        total_bytes: 4_194_304,
        active: true,
        updated_at: 1,
      }),
    ).toBe('1.0 MiB / 4.0 MiB');
    expect(
      transferLabel({
        contract_version: 1,
        digest: DIGEST,
        phase: 'downloading',
        downloaded_bytes: 512,
        total_bytes: null,
        active: true,
        updated_at: 1,
      }),
    ).toBe('512 B transferred');
  });

  it('clones the declaration instead of dropping it', () => {
    const declaration = policy({
      access: { read: [], write: [] },
      rootfs: { kind: 'image', digest: DIGEST },
      mounts: [
        {
          source: { kind: 'image', digest: TOOL_DIGEST },
          target: '/opt/rust',
          read_only: true,
        },
      ],
      workspace: { kind: 'managed', name: 'fixture' },
    });
    const cloned = draftForContext(contextWith(declaration));
    expect(cloned.filesystem?.rootfs).toEqual({ kind: 'image', digest: DIGEST });
    expect(cloned.filesystem?.mounts).toEqual(declaration.filesystem?.mounts);
    expect(cloned.filesystem?.workspace).toEqual({ kind: 'managed', name: 'fixture' });
  });
});
