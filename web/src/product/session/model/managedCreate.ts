import {
  imageExecutionBarrier,
  imagePlatformCompatible,
  imageRoleCompatible,
  imageRoleLabel,
  libraryImageRole,
  representationLabel,
  type ImageConsumerRole,
  type ImageDescriptor,
  type ImageLibraryEntry,
} from '@/capabilities/images';
import type { Agent, EnvFileRef } from '@/types';
import type { Project } from '@/product/project/types';
import type {
  ClientManagedCreate,
  ManagedToolchainRequest,
} from '@/generated/protocol/core/server-session-create/v1';
import { validateCreateEnvSelection, validateSessionName } from './createSessionValidation';
import type { CreateEnvSelectionMode } from './envSelection';

/** How a Project Session chooses its runtime (#3794). */
export type ProjectRuntimeMode = 'native' | 'managed';

/** The platform an Agent advertises, or `null` when it did not say. */
export function agentPlatform(agent: Agent | undefined): string | null {
  const os = agent?.metadata?.os;
  const architecture = agent?.metadata?.architecture;
  return os && architecture ? `${os}/${architecture}` : null;
}

/** Why a Library revision cannot be consumed for a role, or `null`. */
export function imageCandidateBlockReason(
  entry: ImageLibraryEntry,
  expected: ImageConsumerRole,
  platform: string | null,
): string | null {
  const digest = entry.manifest_digest ?? entry.image.digest;
  if (!digest) {
    return 'Image has no immutable digest';
  }
  if (entry.image.status !== 'ready') {
    return `Image is ${entry.image.status}, not Server Ready`;
  }
  const barrier = imageExecutionBarrier(entry);
  if (barrier) {
    return barrier;
  }
  if (!imageRoleCompatible(entry, expected)) {
    return `Image role is ${imageRoleLabel(libraryImageRole(entry))}`;
  }
  if (!imagePlatformCompatible(entry, platform)) {
    return `Platform ${entry.platform ?? 'unknown'} does not match ${platform ?? 'the Agent'}`;
  }
  return null;
}

/** The digest a Managed create names for one Library revision. */
export function managedImageDigest(entry: ImageLibraryEntry): string {
  return entry.manifest_digest ?? entry.image.digest ?? '';
}

/** The one-line image identity shown in the picker. */
export function managedImageLabel(entry: ImageLibraryEntry): string {
  const digest = managedImageDigest(entry);
  return `${entry.tags[0] ?? entry.image.alias ?? entry.image.image_id} · ${digest.slice(0, 19)}…`;
}

/** The target the Agent will resolve for one toolchain, or its advisory default. */
export function toolchainTargetLabel(entry: ImageLibraryEntry | undefined): string {
  if (!entry) {
    return 'Target resolved by the Agent';
  }
  return entry.mount_default ?? 'Target resolved by the Agent';
}

/** A truthful source label for the pinned Project image. */
export function projectImageSourceLabel(descriptor: ImageDescriptor): string {
  switch (descriptor.source.kind) {
    case 'github':
      return `${descriptor.source.repository_url}@${descriptor.source.ref}${
        descriptor.source_sha ? ` (${descriptor.source_sha.slice(0, 12)})` : ''
      }`;
    case 'local_directory':
      return descriptor.source.path;
    case 'compose':
      return `Compose · ${representationLabel(
        descriptor.source.representation === 'referenced'
          ? 'referenced'
          : 'flattened',
      )}`;
  }
}

function normalizedGitUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const withoutGit = trimmed.endsWith('.git')
    ? trimmed.slice(0, -4)
    : trimmed;
  return withoutGit.replace(/\/+$/, '').toLowerCase();
}

function isFullCommit(reference: string): boolean {
  return /^[0-9a-f]{40}$/i.test(reference);
}

/**
 * Whether the Project's declared Git Source still names the pinned image's
 * source (#3794 SC-03). The Server enforces the same rule; this only prevents
 * presenting a stale pin as ready.
 */
export function projectSourceIsStale(
  project: Project,
  descriptor: ImageDescriptor,
): boolean {
  const projectSource = project.source;
  const imageSource = descriptor.source;
  if (!projectSource || imageSource.kind !== 'github') {
    return false;
  }
  if (normalizedGitUrl(projectSource.repository_url) !== normalizedGitUrl(imageSource.repository_url)) {
    return true;
  }
  const projectRef = projectSource.ref.trim();
  if (isFullCommit(projectRef)) {
    return descriptor.source_sha !== undefined
      && descriptor.source_sha !== null
      && descriptor.source_sha.toLowerCase() !== projectRef.toLowerCase();
  }
  return projectRef !== imageSource.ref.trim();
}

/** The exact Managed create request the Web sends. */
export function managedCreateRequest(
  baseDigest: string,
  toolchains: readonly string[],
): ClientManagedCreate {
  const requests: ManagedToolchainRequest[] = toolchains.map((digest) => ({ digest }));
  return {
    base_digest: baseDigest,
    toolchains: requests,
  };
}

/** The pre-review blockers for a Managed Project Session. */
export function validateManagedCreate({
  sessionName,
  project,
  agent,
  baseDigest,
  toolchains,
  projectSource,
  projectSourceError,
  envSelectionMode,
  selectedEnv,
  unavailableEnv,
}: {
  sessionName: string;
  project: Project;
  agent: Agent | undefined;
  baseDigest: string;
  toolchains: readonly string[];
  projectSource: ImageDescriptor | null;
  projectSourceError: string | null;
  envSelectionMode: CreateEnvSelectionMode;
  selectedEnv: EnvFileRef[];
  unavailableEnv: EnvFileRef[];
}): string | null {
  const nameError = validateSessionName(sessionName);
  if (nameError) {
    return nameError;
  }
  if (!project.image_digest) {
    return 'This Project does not pin a Source image. Choose an Existing Location instead.';
  }
  if (!agent) {
    return 'Select an online Agent for the Managed Session.';
  }
  if (agent.status !== 'online') {
    return 'The selected Agent is offline.';
  }
  if (!baseDigest) {
    return 'Select a Base Runtime image.';
  }
  // An empty toolchain list is a valid Base-only composition. A selected
  // entry must still name an immutable digest.
  if (toolchains.some((digest) => digest.trim().length === 0)) {
    return 'Select a valid Toolchain image.';
  }
  if (projectSourceError) {
    return `The Project Source image cannot be resolved: ${projectSourceError}`;
  }
  if (!projectSource) {
    return 'The Project Source image is not loaded yet.';
  }
  if (projectSource.status !== 'ready' || !projectSource.digest) {
    return 'The Project Source image is not Server Ready.';
  }
  if (projectSourceIsStale(project, projectSource)) {
    return 'The Project Git Source changed after its image was pinned. Re-pin the Project image before creating a Managed Session.';
  }
  return validateCreateEnvSelection({
    project,
    envSelectionMode,
    selectedEnv,
    unavailableEnv,
  });
}
