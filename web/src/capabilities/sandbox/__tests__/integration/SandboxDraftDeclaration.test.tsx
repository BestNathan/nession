import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  SandboxCurrentContext,
  SandboxPolicyDraft,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { useSandboxDraft } from '../../hooks/useSandboxDraft';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const TOOL_DIGEST = `sha256:${'b'.repeat(64)}`;

function emptyPolicy(): SandboxPolicyDraft {
  return {
    version: 1,
    enabled: true,
    network: { mode: 'allow', ingress: 'deny' },
    resource: [],
    syscall: [],
    enforcement: 'required',
  };
}

function context(): SandboxCurrentContext {
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
    effective_policy: emptyPolicy(),
  };
}

function renderDraft() {
  return renderHook(() => useSandboxDraft(context()));
}

describe('useSandboxDraft declaration mutations', () => {
  it('sets and clears the RootFS while preserving access edits', () => {
    const { result } = renderDraft();
    act(() => result.current.addFilesystemPath('read'));
    act(() => result.current.updateFilesystemPath('read', 0, '/usr'));
    act(() => result.current.setFilesystemRootfs({ kind: 'image', digest: DIGEST }));
    expect(result.current.draft.filesystem?.rootfs).toEqual({
      kind: 'image',
      digest: DIGEST,
    });
    expect(result.current.draft.filesystem?.access.read).toEqual(['/usr']);
    act(() => result.current.setFilesystemRootfs(undefined));
    expect(result.current.draft.filesystem?.rootfs).toBeUndefined();
    expect(result.current.draft.filesystem?.access.read).toEqual(['/usr']);
  });

  it('adds, retargets and removes mounts and workspaces', () => {
    const { result } = renderDraft();
    act(() =>
      result.current.addMount({
        source: { kind: 'image', digest: TOOL_DIGEST },
        target: '/opt/rust',
        read_only: true,
      }),
    );
    act(() => result.current.updateMountTarget(0, '/opt/go'));
    act(() => result.current.setFilesystemWorkspace({ kind: 'auto' }));
    expect(result.current.draft.filesystem?.mounts?.[0]?.target).toBe('/opt/go');
    expect(result.current.draft.filesystem?.workspace).toEqual({ kind: 'auto' });
    act(() => result.current.removeMount(0));
    act(() => result.current.setFilesystemWorkspace(undefined));
    expect(result.current.draft.filesystem?.mounts).toEqual([]);
    expect(result.current.draft.filesystem?.workspace).toBeUndefined();
  });

  it('clearing access keeps the image declaration', () => {
    const { result } = renderDraft();
    act(() => result.current.setFilesystemRootfs({ kind: 'image', digest: DIGEST }));
    act(() => result.current.addFilesystemPath('write'));
    act(() => result.current.updateFilesystemPath('write', 0, '/workspace'));
    act(() => result.current.clearFilesystemAccess());
    expect(result.current.draft.filesystem?.access).toEqual({ read: [], write: [] });
    expect(result.current.draft.filesystem?.rootfs).toEqual({
      kind: 'image',
      digest: DIGEST,
    });
  });
});
