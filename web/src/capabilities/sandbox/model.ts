import type {
  SandboxCapabilityCatalog,
  SandboxCurrentContext,
  SandboxFieldEntry,
  SandboxFilesystemPolicy,
  SandboxFilesystemRoot,
  SandboxFilesystemWorkspace,
  SandboxImplementationSupport,
  ImageCacheObservation,
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
  composition: 'filesystem.composition',
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
          ...(draft.filesystem.rootfs ? { rootfs: { ...draft.filesystem.rootfs } } : {}),
          ...(draft.filesystem.mounts
            ? {
                mounts: draft.filesystem.mounts.map((mount) => ({
                  source: { ...mount.source },
                  target: mount.target,
                  read_only: mount.read_only,
                })),
              }
            : {}),
          ...(draft.filesystem.workspace
            ? { workspace: { ...draft.filesystem.workspace } }
            : {}),
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

/** Whether the draft declares a prepared image root/mounts/Workspace. */
export function declarationActive(filesystem: SandboxFilesystemPolicy | undefined): boolean {
  return (
    filesystem?.rootfs !== undefined
    || (filesystem?.mounts?.length ?? 0) > 0
    || filesystem?.workspace !== undefined
  );
}

/** Every digest the declaration asks the Agent to prepare. */
export function declaredDigests(draft: SandboxPolicyDraft): string[] {
  const filesystem = draft.filesystem;
  if (!filesystem) {
    return [];
  }
  const digests: string[] = [];
  if (filesystem.rootfs?.kind === 'image') {
    digests.push(filesystem.rootfs.digest);
  }
  for (const mount of filesystem.mounts ?? []) {
    digests.push(mount.source.digest);
  }
  return [...new Set(digests)];
}

/** Whether an image root + mounts/Workspace replace the V1 access maps. */
export function accessConflictsWithDeclaration(
  filesystem: SandboxFilesystemPolicy | undefined,
): boolean {
  const prepared =
    filesystem?.rootfs?.kind === 'image'
    || (filesystem?.mounts?.length ?? 0) > 0
    || filesystem?.workspace !== undefined;
  return (
    prepared
    && ((filesystem?.access.read.length ?? 0) > 0 || (filesystem?.access.write.length ?? 0) > 0)
  );
}

/**
 * The V1 mount target rule, mirrored for inline feedback.
 *
 * `nession-sandbox::compile` remains the authority; this only helps the
 * editor show an error before preflight.
 */
export function mountTargetError(target: string): string | null {
  const match = /^\/opt\/([a-z0-9][a-z0-9._-]{0,62})$/.exec(target.trim());
  if (!match) {
    return 'Mount targets are /opt/<lowercase-name> in the first implementation.';
  }
  return null;
}

/** A short, human label for a RootFS selection. */
export function rootfsLabel(rootfs: SandboxFilesystemRoot | undefined): string {
  if (!rootfs) {
    return 'Local host root';
  }
  return rootfs.kind === 'local' ? 'Local host root' : 'Base Runtime image';
}

/** A short, human label for a Workspace selection. */
export function workspaceLabel(workspace: SandboxFilesystemWorkspace | undefined): string {
  if (!workspace) {
    return 'Execution scratch directory';
  }
  switch (workspace.kind) {
    case 'auto':
      return 'Auto by Session name';
    case 'project_location':
      return 'Project Location';
    case 'managed':
      return workspace.workspace_id
        ? `Managed ${workspace.workspace_id}`
        : `Managed “${workspace.name ?? ''}”`;
  }
}

/** A stable signature over the draft alone; the declaration is part of it. */
export function sandboxDraftSignature(draft: SandboxPolicyDraft): string {
  return draftSignature(draft);
}

/** The Agent's measured cache phase, in user-facing words. */
export function observationPhaseLabel(phase: ImageCacheObservation['phase']): string {
  switch (phase) {
    case 'absent':
      return 'Not cached';
    case 'resumable':
      return 'Resumable partial';
    case 'downloading':
      return 'Downloading';
    case 'verifying':
      return 'Verifying';
    case 'verified':
      return 'Verified';
    case 'failed':
      return 'Cache failed';
    case 'unavailable':
      return 'Cache unavailable';
  }
}

/** Whether the cache phase is mount-ready (only a verified digest is). */
export function observationReady(phase: ImageCacheObservation['phase']): boolean {
  return phase === 'verified';
}

/** A compact byte count; `—` when the Agent did not measure one. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `downloaded / total` with a percent only when the total is measured. */
export function transferLabel(observation: ImageCacheObservation): string {
  const downloaded = formatBytes(observation.downloaded_bytes);
  const total = observation.total_bytes;
  if (total === null || total === undefined || total <= 0) {
    return observation.downloaded_bytes ? `${downloaded} transferred` : 'Size not measured';
  }
  return `${downloaded} / ${formatBytes(total)}`;
}
