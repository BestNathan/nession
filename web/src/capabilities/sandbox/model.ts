import type {
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
  SandboxFieldEntry,
  SandboxKvEntry,
  SandboxPolicyDraft,
  SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import type { CapabilityId } from '@/product/capability';

/** A transition refusal rendered by the composer/confirmation. */
export interface SandboxActionError {
  kind?: string | null;
  message: string;
  fieldErrors?: Record<string, string>;
}

/** The capability's registered identity. */
export const SANDBOX_CAPABILITY_ID: CapabilityId = 'sandbox';
export const SANDBOX_TITLE = 'Sandbox';

/**
 * Sandbox exists where there is a Session and the Agent that owns it. Whether
 * the host can offer Enter, and whether the active Pane is already inside, is
 * the Agent's authenticated answer — never inferred here.
 */
export function resolveSandboxCapabilityState(ctx: {
  sessionId?: string;
  agentId?: string;
}): 'available' | 'unavailable' {
  return ctx.sessionId && ctx.agentId ? 'available' : 'unavailable';
}

/**
 * The empty-first draft the outside composer starts from.
 *
 * Nothing is preselected: no filesystem path, no optional Resource/Syscall
 * row and no namespace. The two optional groups are empty lists, which the
 * Agent omits from the materialized policy rather than sending as `{}`.
 */
export function emptySandboxDraft(): SandboxPolicyDraft {
  return {
    version: 1,
    enabled: true,
    filesystem: undefined,
    network: { mode: 'allow', ingress: 'deny' },
    resource: [],
    syscall: [],
    enforcement: 'required',
  };
}

/**
 * The observed effective policy, or the empty draft when the Pane is outside.
 *
 * Inside, the draft is a read-only projection of what the Agent verified; the
 * composer never sends it back as a new request.
 */
export function draftForContext(context: SandboxCurrentContext | null): SandboxPolicyDraft {
  return context?.effective_policy ? cloneDraft(context.effective_policy) : emptySandboxDraft();
}

function cloneDraft(draft: SandboxPolicyDraft): SandboxPolicyDraft {
  return {
    version: draft.version,
    enabled: draft.enabled,
    filesystem: draft.filesystem
      ? {
          access: {
            read: [...draft.filesystem.access.read],
            write: [...draft.filesystem.access.write],
          },
        }
      : undefined,
    network: draft.network
      ? {
          mode: draft.network.mode,
          ...(draft.network.egress
            ? {
                egress: {
                  allow: [...draft.network.egress.allow],
                  deny: [...draft.network.egress.deny],
                  private_network: draft.network.egress.private_network,
                },
              }
            : {}),
          ingress: draft.network.ingress,
        }
      : undefined,
    process: draft.process
      ? {
          linux_namespaces: draft.process.linux_namespaces
            ? { ...draft.process.linux_namespaces }
            : undefined,
        }
      : undefined,
    resource: draft.resource.map((row) => ({ ...row })),
    syscall: draft.syscall.map((row) => ({ ...row })),
    enforcement: draft.enforcement,
  };
}

/** A stable comparison for "the draft changed since preflight". */
export function draftSignature(draft: SandboxPolicyDraft): string {
  return JSON.stringify(draft);
}

/** One additive row edit; empty lists stay empty rather than becoming groups. */
export function addKvRow(rows: SandboxKvEntry[]): SandboxKvEntry[] {
  return [...rows, { key: '', value: '' }];
}

export function updateKvRow(
  rows: SandboxKvEntry[],
  index: number,
  patch: Partial<SandboxKvEntry>,
): SandboxKvEntry[] {
  return rows.map((row, at) => (at === index ? { ...row, ...patch } : row));
}

export function removeKvRow(rows: SandboxKvEntry[], index: number): SandboxKvEntry[] {
  return rows.filter((_, at) => at !== index);
}

/** Newline-separated path/rule text → the draft's list field. */
export function linesToEntries(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function entriesToLines(entries: string[]): string {
  return entries.join('\n');
}

/** The catalog's entries for one group, or none when the Agent has not probed. */
export function catalogOptions(
  catalog: SandboxCapabilityCatalog | undefined,
  group: 'resource' | 'syscall',
): SandboxFieldEntry[] {
  if (!catalog) {
    return [];
  }
  return group === 'resource' ? catalog.resource_fields : catalog.syscall_fields;
}

/** Field errors keyed by `field`, for rendering next to the row they name. */
export function fieldErrorsByField(
  errors: { field: string; message: string; code: string }[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const error of errors ?? []) {
    map[error.field] = error.message;
  }
  return map;
}

/** Whether the Agent's catalog says the host can offer Enter at all. */
export function catalogOffersEnter(context: SandboxCurrentContext): boolean {
  return context.catalog.status === 'available' && context.catalog.backend !== null;
}

/** Whether a preflight still describes the draft and context on screen. */
export function preflightIsValid(
  preflight: { signature: string; result: SandboxPreflightResult } | null,
  signature: string,
  generation: string,
): boolean {
  return (
    preflight !== null &&
    preflight.signature === signature &&
    preflight.result.ok &&
    preflight.result.generation === generation
  );
}

/** Why the Resource group cannot be edited on this Agent, or `null`. */
export function resourceDisabledReason(catalog: SandboxCapabilityCatalog): string | null {
  if (catalog.platform === 'macos') {
    return 'Linux-native Resource controls are unavailable on macOS; Seatbelt reports only its measured network denial.';
  }
  if (catalog.status !== 'available') {
    return catalog.reason ?? 'The Agent has not measured cgroup v2 installability.';
  }
  return catalogOptions(catalog, 'resource').length === 0
    ? 'The Agent measured no installable cgroup v2 control file.'
    : null;
}

/** Why the Syscall group cannot be edited on this Agent, or `null`. */
export function syscallDisabledReason(catalog: SandboxCapabilityCatalog): string | null {
  if (catalog.platform === 'macos') {
    return 'Linux-native Syscall controls are unavailable on macOS.';
  }
  if (catalog.status !== 'available') {
    return catalog.reason ?? 'The Agent has not probed seccomp profile loading.';
  }
  return catalogOptions(catalog, 'syscall').length === 0
    ? 'The Agent probed no loadable seccomp profile.'
    : null;
}
