import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  SandboxCurrentContext,
  SandboxFilesystemPolicy,
  SandboxFilesystemRoot,
  SandboxFilesystemWorkspace,
  SandboxKvEntry,
  SandboxMount,
  SandboxPolicyDraft,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  addKvRow,
  draftForContext,
  draftSignature,
  removeKvRow,
  updateKvRow,
} from '../model';

const EMPTY_ACCESS = { read: [] as string[], write: [] as string[] };

export interface SandboxDraftState {
  draft: SandboxPolicyDraft;
  /** The draft as it was when the pane's context was observed. */
  baseline: SandboxPolicyDraft;
  dirty: boolean;
  patch: (next: Partial<SandboxPolicyDraft>) => void;
  addFilesystemPath: (field: 'read' | 'write') => void;
  updateFilesystemPath: (field: 'read' | 'write', index: number, value: string) => void;
  removeFilesystemPath: (field: 'read' | 'write', index: number) => void;
  clearFilesystemAccess: () => void;
  setFilesystemRootfs: (rootfs: SandboxFilesystemRoot | undefined) => void;
  addMount: (mount: SandboxMount) => void;
  updateMountTarget: (index: number, target: string) => void;
  removeMount: (index: number) => void;
  setFilesystemWorkspace: (workspace: SandboxFilesystemWorkspace | undefined) => void;
  addEgressRule: (field: 'allow' | 'deny') => void;
  updateEgressRule: (field: 'allow' | 'deny', index: number, value: string) => void;
  removeEgressRule: (field: 'allow' | 'deny', index: number) => void;
  toggleNamespace: (namespace: 'pid' | 'ipc' | 'user' | 'uts' | 'cgroup') => void;
  addRow: (group: 'resource' | 'syscall') => void;
  updateRow: (group: 'resource' | 'syscall', index: number, patch: Partial<SandboxKvEntry>) => void;
  removeRow: (group: 'resource' | 'syscall', index: number) => void;
  reset: () => void;
}

function withFilesystem(
  draft: SandboxPolicyDraft,
  update: (filesystem: SandboxFilesystemPolicy) => SandboxFilesystemPolicy,
): SandboxPolicyDraft {
  const filesystem = draft.filesystem ?? { access: { ...EMPTY_ACCESS } };
  return { ...draft, filesystem: update(filesystem) };
}

function withFilesystemList(
  draft: SandboxPolicyDraft,
  field: 'read' | 'write',
  update: (list: string[]) => string[],
): SandboxPolicyDraft {
  return withFilesystem(draft, (filesystem) => {
    const access = filesystem.access ?? EMPTY_ACCESS;
    const list = update(field === 'read' ? access.read : access.write);
    return {
      ...filesystem,
      access: {
        read: field === 'read' ? list : access.read,
        write: field === 'write' ? list : access.write,
      },
    };
  });
}

function withEgressList(
  draft: SandboxPolicyDraft,
  field: 'allow' | 'deny',
  update: (list: string[]) => string[],
): SandboxPolicyDraft {
  const egress = draft.network?.egress ?? { allow: [], deny: [], private_network: 'deny' };
  const list = update(field === 'allow' ? egress.allow : egress.deny);
  return {
    ...draft,
    network: {
      mode: draft.network?.mode ?? 'allow',
      ingress: 'deny',
      egress: {
        allow: field === 'allow' ? list : egress.allow,
        deny: field === 'deny' ? list : egress.deny,
        private_network: 'deny',
      },
    },
  };
}

/** Declaration edits for the Filesystem editor (#3405, #3408). */
function useFilesystemDeclarationMutations(
  setDraft: Dispatch<SetStateAction<SandboxPolicyDraft>>,
) {
  const setFilesystemRootfs = useCallback((rootfs: SandboxFilesystemRoot | undefined) => {
    setDraft((current) =>
      withFilesystem(current, (filesystem) => {
        const next = { ...filesystem };
        if (rootfs) {
          next.rootfs = rootfs;
        } else {
          delete next.rootfs;
        }
        return next;
      }),
    );
  }, [setDraft]);

  const addMount = useCallback((mount: SandboxMount) => {
    setDraft((current) =>
      withFilesystem(current, (filesystem) => ({
        ...filesystem,
        mounts: [...(filesystem.mounts ?? []), mount],
      })),
    );
  }, [setDraft]);

  const updateMountTarget = useCallback((index: number, target: string) => {
    setDraft((current) =>
      withFilesystem(current, (filesystem) => ({
        ...filesystem,
        mounts: (filesystem.mounts ?? []).map((mount, at) =>
          at === index ? { ...mount, target } : mount,
        ),
      })),
    );
  }, [setDraft]);

  const removeMount = useCallback((index: number) => {
    setDraft((current) =>
      withFilesystem(current, (filesystem) => ({
        ...filesystem,
        mounts: (filesystem.mounts ?? []).filter((_, at) => at !== index),
      })),
    );
  }, [setDraft]);

  const setFilesystemWorkspace = useCallback(
    (workspace: SandboxFilesystemWorkspace | undefined) => {
      setDraft((current) =>
        withFilesystem(current, (filesystem) => {
          const next = { ...filesystem };
          if (workspace) {
            next.workspace = workspace;
          } else {
            delete next.workspace;
          }
          return next;
        }),
      );
    },
    [setDraft],
  );

  return {
    setFilesystemRootfs,
    addMount,
    updateMountTarget,
    removeMount,
    setFilesystemWorkspace,
  };
}

/**
 * The explicit outside-draft (#3124, #3143).
 *
 * Nothing is preselected. Any edit changes the draft signature, which the view
 * uses to invalidate a preflight that no longer describes it: Enter stays
 * disabled until the edited draft has been validated again. Switching tabs
 * never touches this state.
 */
export function useSandboxDraft(context: SandboxCurrentContext | null): SandboxDraftState {
  const baseline = useMemo(() => draftForContext(context), [context]);
  const [draft, setDraft] = useState<SandboxPolicyDraft>(baseline);
  const declaration = useFilesystemDeclarationMutations(setDraft);
  const dirty = draftSignature(draft) !== draftSignature(baseline);

  const patch = useCallback((next: Partial<SandboxPolicyDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const addFilesystemPath = useCallback((field: 'read' | 'write') => {
    setDraft((current) =>
      withFilesystemList(current, field, (list) => [...list, '']),
    );
  }, []);

  const updateFilesystemPath = useCallback(
    (field: 'read' | 'write', index: number, value: string) => {
      setDraft((current) =>
        withFilesystemList(current, field, (list) =>
          list.map((entry, at) => (at === index ? value : entry)),
        ),
      );
    },
    [],
  );

  const removeFilesystemPath = useCallback((field: 'read' | 'write', index: number) => {
    setDraft((current) =>
      withFilesystemList(current, field, (list) => list.filter((_, at) => at !== index)),
    );
  }, []);

  const clearFilesystemAccess = useCallback(() => {
    setDraft((current) =>
      withFilesystem(current, (filesystem) => ({
        ...filesystem,
        access: { read: [], write: [] },
      })),
    );
  }, []);

  const addEgressRule = useCallback((field: 'allow' | 'deny') => {
    setDraft((current) => withEgressList(current, field, (list) => [...list, '']));
  }, []);

  const updateEgressRule = useCallback(
    (field: 'allow' | 'deny', index: number, value: string) => {
      setDraft((current) =>
        withEgressList(current, field, (list) =>
          list.map((entry, at) => (at === index ? value : entry)),
        ),
      );
    },
    [],
  );

  const removeEgressRule = useCallback((field: 'allow' | 'deny', index: number) => {
    setDraft((current) =>
      withEgressList(current, field, (list) => list.filter((_, at) => at !== index)),
    );
  }, []);

  const toggleNamespace = useCallback(
    (namespace: 'pid' | 'ipc' | 'user' | 'uts' | 'cgroup') => {
      setDraft((current) => {
        const existing = current.process?.linux_namespaces ?? {
          pid: false,
          ipc: false,
          user: false,
          uts: false,
          cgroup: false,
        };
        const namespaces = { ...existing, [namespace]: !existing[namespace] };
        const any = Object.values(namespaces).some(Boolean);
        return {
          ...current,
          process: any ? { linux_namespaces: namespaces } : undefined,
        };
      });
    },
    [],
  );

  const addRow = useCallback((group: 'resource' | 'syscall') => {
    setDraft((current) => ({ ...current, [group]: addKvRow(current[group]) }));
  }, []);

  const updateRow = useCallback(
    (group: 'resource' | 'syscall', index: number, patchRow: Partial<SandboxKvEntry>) => {
      setDraft((current) => ({
        ...current,
        [group]: updateKvRow(current[group], index, patchRow),
      }));
    },
    [],
  );

  const removeRow = useCallback((group: 'resource' | 'syscall', index: number) => {
    setDraft((current) => ({ ...current, [group]: removeKvRow(current[group], index) }));
  }, []);

  const reset = useCallback(() => {
    setDraft(baseline);
  }, [baseline]);

  return {
    draft,
    baseline,
    dirty,
    patch,
    addFilesystemPath,
    updateFilesystemPath,
    removeFilesystemPath,
    clearFilesystemAccess,
    ...declaration,
    addEgressRule,
    updateEgressRule,
    removeEgressRule,
    toggleNamespace,
    addRow,
    updateRow,
    removeRow,
    reset,
  };
}
