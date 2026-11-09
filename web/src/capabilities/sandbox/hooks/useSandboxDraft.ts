import { useCallback, useMemo, useState } from 'react';
import type {
  SandboxCurrentContext,
  SandboxKvEntry,
  SandboxPolicyDraft,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import {
  addKvRow,
  draftForContext,
  draftSignature,
  linesToEntries,
  removeKvRow,
  updateKvRow,
} from '../model';

export interface SandboxDraftState {
  draft: SandboxPolicyDraft;
  /** The draft as it was when the pane's context was observed. */
  baseline: SandboxPolicyDraft;
  dirty: boolean;
  patch: (next: Partial<SandboxPolicyDraft>) => void;
  setFilesystemPaths: (field: 'read' | 'write', text: string) => void;
  setEgress: (field: 'allow' | 'deny', text: string) => void;
  toggleNamespace: (namespace: 'pid' | 'ipc' | 'user' | 'uts' | 'cgroup') => void;
  addRow: (group: 'resource' | 'syscall') => void;
  updateRow: (group: 'resource' | 'syscall', index: number, patch: Partial<SandboxKvEntry>) => void;
  removeRow: (group: 'resource' | 'syscall', index: number) => void;
  reset: () => void;
}

/**
 * The explicit outside-draft (#3124).
 *
 * Nothing is preselected. Any edit changes the draft signature, which the view
 * uses to invalidate a preflight that no longer describes it: Enter stays
 * disabled until the edited draft has been validated again.
 */
export function useSandboxDraft(context: SandboxCurrentContext | null): SandboxDraftState {
  const baseline = useMemo(() => draftForContext(context), [context]);
  const [draft, setDraft] = useState<SandboxPolicyDraft>(baseline);
  const baselineSignature = draftSignature(baseline);
  const dirty = draftSignature(draft) !== baselineSignature;

  const patch = useCallback((next: Partial<SandboxPolicyDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const setFilesystemPaths = useCallback((field: 'read' | 'write', text: string) => {
    setDraft((current) => ({
      ...current,
      filesystem: {
        access: {
          read: field === 'read' ? linesToEntries(text) : (current.filesystem?.access.read ?? []),
          write:
            field === 'write' ? linesToEntries(text) : (current.filesystem?.access.write ?? []),
        },
      },
    }));
  }, []);

  const setEgress = useCallback((field: 'allow' | 'deny', text: string) => {
    setDraft((current) => ({
      ...current,
      network: {
        mode: current.network?.mode ?? 'allow',
        ingress: 'deny',
        ...(current.network?.egress
          ? {
              egress: {
                allow:
                  field === 'allow'
                    ? linesToEntries(text)
                    : current.network.egress.allow,
                deny:
                  field === 'deny' ? linesToEntries(text) : current.network.egress.deny,
                private_network: 'deny',
              },
            }
          : field === 'deny'
            ? { egress: { allow: [], deny: linesToEntries(text), private_network: 'deny' } }
            : { egress: { allow: linesToEntries(text), deny: [], private_network: 'deny' } }),
      },
    }));
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
    setFilesystemPaths,
    setEgress,
    toggleNamespace,
    addRow,
    updateRow,
    removeRow,
    reset,
  };
}
