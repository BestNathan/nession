import type {
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
  SandboxFieldEntry,
  SandboxImplementationSupport,
  SandboxKvEntry,
  SandboxOptionSupport,
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

/** Canonical policy paths the production UI can compose. */
export const IMPLEMENTATION_PATHS = {
  filesystemAccess: 'filesystem.access',
  filesystemComposition: 'filesystem.composition',
  network: 'network',
  linuxNamespaces: 'process.linux_namespaces',
  cgroupV2: 'resource.cgroup_v2',
  seccomp: 'syscall.seccomp',
} as const;

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

/** One implementation's support entry, when this catalog reported the path. */
export function implementationSupport(
  catalog: SandboxCapabilityCatalog | undefined,
  path: string,
): SandboxImplementationSupport | undefined {
  return catalog?.implementations.find((implementation) => implementation.path === path);
}

/** Whether an implementation can be used to compose a draft. */
export function implementationEditable(
  catalog: SandboxCapabilityCatalog | undefined,
  path: string,
): boolean {
  return implementationSupport(catalog, path)?.status === 'available';
}

/** Why one implementation cannot be edited, or `null` when it is available. */
export function implementationDisabledReason(
  catalog: SandboxCapabilityCatalog | undefined,
  path: string,
): string | null {
  const implementation = implementationSupport(catalog, path);
  if (!implementation) {
    return 'This Agent did not report per-implementation support; reconnect or update it before editing.';
  }
  if (implementation.status === 'available') {
    return null;
  }
  return implementation.reason ?? `This Agent measured ${path} as ${implementation.status}.`;
}

/** One typed option's support entry, when the implementation declares it. */
export function optionSupport(
  implementation: SandboxImplementationSupport | undefined,
  id: string,
): SandboxOptionSupport | undefined {
  return implementation?.options?.find((option) => option.id === id);
}

/** Whether a mode/namespace/profile option can be selected at all. */
export function optionAvailable(
  catalog: SandboxCapabilityCatalog | undefined,
  path: string,
  id: string,
): boolean {
  const implementation = implementationSupport(catalog, path);
  const option = optionSupport(implementation, id);
  if (option) {
    return option.status === 'available';
  }
  // A missing option is not a support claim. If the implementation itself is
  // available but the option is absent, the Agent does not implement it.
  return false;
}

/** Why one option cannot be selected, or `null` when it is available. */
export function optionDisabledReason(
  catalog: SandboxCapabilityCatalog | undefined,
  path: string,
  id: string,
): string | null {
  const implementation = implementationSupport(catalog, path);
  const option = optionSupport(implementation, id);
  if (option?.status === 'available') {
    return null;
  }
  if (option?.reason) {
    return option.reason;
  }
  return implementation?.reason ?? `${id} was not measured as available on this Agent.`;
}

/** The cgroup v2 control files this catalog offers, in canonical order. */
export function resourceFieldOptions(
  catalog: SandboxCapabilityCatalog | undefined,
): SandboxFieldEntry[] {
  const implementation = implementationSupport(catalog, IMPLEMENTATION_PATHS.cgroupV2);
  if (implementation?.fields?.length) {
    return implementation.fields;
  }
  return catalog?.resource_fields ?? [];
}

/**
 * The seccomp profiles this catalog offers, projected into the shared
 * Key/Value row shape (`seccomp.profile` is the one native row key).
 */
export function syscallFieldOptions(
  catalog: SandboxCapabilityCatalog | undefined,
): SandboxFieldEntry[] {
  const implementation = implementationSupport(catalog, IMPLEMENTATION_PATHS.seccomp);
  if (implementation?.options?.length) {
    return implementation.options.map((option) => ({
      key: 'seccomp.profile',
      controller: null,
      value_format: 'registered Agent seccomp profile',
      example: option.id,
      available: option.status === 'available',
      reason_code: option.reason_code,
      reason: option.reason,
    }));
  }
  return catalog?.syscall_fields ?? [];
}

/** The catalog's entries for one group, or none when the Agent has not probed. */
export function catalogOptions(
  catalog: SandboxCapabilityCatalog | undefined,
  group: 'resource' | 'syscall',
): SandboxFieldEntry[] {
  if (!catalog) {
    return [];
  }
  return group === 'resource' ? resourceFieldOptions(catalog) : syscallFieldOptions(catalog);
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

/** Whether a preflight still describes the draft, context and probe on screen. */
export function preflightIsValid(
  preflight: { signature: string; result: SandboxPreflightResult } | null,
  signature: string,
  generation: string,
  probeGeneration: string,
): boolean {
  return (
    preflight !== null &&
    preflight.signature === signature &&
    preflight.result.ok &&
    preflight.result.generation === generation &&
    preflight.result.catalog.probe_generation === probeGeneration
  );
}

/** Why the Resource group cannot be edited on this Agent, or `null`. */
export function resourceDisabledReason(catalog: SandboxCapabilityCatalog): string | null {
  const reason = implementationDisabledReason(catalog, IMPLEMENTATION_PATHS.cgroupV2);
  if (reason) {
    return reason;
  }
  return catalogOptions(catalog, 'resource').length === 0
    ? 'The Agent measured no installable cgroup v2 control file.'
    : null;
}

/** Why the Syscall group cannot be edited on this Agent, or `null`. */
export function syscallDisabledReason(catalog: SandboxCapabilityCatalog): string | null {
  const reason = implementationDisabledReason(catalog, IMPLEMENTATION_PATHS.seccomp);
  if (reason) {
    return reason;
  }
  return catalogOptions(catalog, 'syscall').length === 0
    ? 'The Agent probed no loadable seccomp profile.'
    : null;
}

/** Why the filesystem path editor cannot be edited on this Agent, or `null`. */
export function filesystemDisabledReason(catalog: SandboxCapabilityCatalog): string | null {
  return implementationDisabledReason(catalog, IMPLEMENTATION_PATHS.filesystemAccess);
}

/** Why one network mode cannot be selected, or `null` when it is available. */
export function networkModeDisabledReason(
  catalog: SandboxCapabilityCatalog,
  mode: string,
): string | null {
  const implementationReason = implementationDisabledReason(catalog, IMPLEMENTATION_PATHS.network);
  if (implementationReason) {
    return implementationReason;
  }
  return optionAvailable(catalog, IMPLEMENTATION_PATHS.network, mode)
    ? null
    : optionDisabledReason(catalog, IMPLEMENTATION_PATHS.network, mode);
}

/** Why one Linux namespace toggle cannot be selected, or `null`. */
export function namespaceDisabledReason(
  catalog: SandboxCapabilityCatalog,
  namespace: string,
): string | null {
  const implementationReason = implementationDisabledReason(
    catalog,
    IMPLEMENTATION_PATHS.linuxNamespaces,
  );
  if (implementationReason) {
    return implementationReason;
  }
  return optionAvailable(catalog, IMPLEMENTATION_PATHS.linuxNamespaces, namespace)
    ? null
    : optionDisabledReason(catalog, IMPLEMENTATION_PATHS.linuxNamespaces, namespace);
}
