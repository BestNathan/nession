// A Session's user-owned display context (#2789), separate from runtime facts.
//
// The bounds mirror the canonical validation in
// `crates/nession-protocol/src/contracts/session/v1.rs`; the Agent is the
// authority and revalidates every write. This module only gives the editor a
// synchronous answer so an invalid draft is not sent at all. Lengths count
// Unicode scalar values (`[...value].length`), matching the Rust check.
import type { SessionMetadata } from '@/generated/protocol/core/server-session-metadata-get/v1';

export const SESSION_METADATA_TITLE_MAX = 120;
export const SESSION_METADATA_DESCRIPTION_MAX = 2_000;
export const SESSION_METADATA_TAG_MAX = 32;
export const SESSION_METADATA_TAG_LIMIT = 12;

export interface SessionMetadataDraft {
  title: string;
  description: string;
  tags: string[];
}

export function draftFromMetadata(
  metadata: SessionMetadata | null | undefined,
): SessionMetadataDraft {
  return {
    title: metadata?.title ?? '',
    description: metadata?.description ?? '',
    tags: [...(metadata?.tags ?? [])],
  };
}

export function codepointLength(value: string): number {
  return [...value].length;
}

/** The title a navigation row or detail header shows. */
export function metadataDisplayTitle(
  metadata: SessionMetadata | null | undefined,
  sessionName: string,
): string {
  const title = metadata?.title?.trim();
  return title ? title : sessionName;
}

function normalized(draft: SessionMetadataDraft): {
  title: string | null;
  description: string | null;
  tags: string[];
} {
  const title = draft.title.trim();
  const description = draft.description.trim();
  return {
    title: title === '' ? null : title,
    description: description === '' ? null : description,
    tags: draft.tags.map((tag) => tag.trim()).filter((tag) => tag !== ''),
  };
}

/** `null` when the draft is valid; otherwise the first actionable problem. */
export function validateSessionMetadataDraft(
  draft: SessionMetadataDraft,
): string | null {
  const value = normalized(draft);
  if (value.title !== null && codepointLength(value.title) > SESSION_METADATA_TITLE_MAX) {
    return `Title must be at most ${SESSION_METADATA_TITLE_MAX} characters.`;
  }
  if (
    value.description !== null &&
    codepointLength(value.description) > SESSION_METADATA_DESCRIPTION_MAX
  ) {
    return `Description must be at most ${SESSION_METADATA_DESCRIPTION_MAX} characters.`;
  }
  if (value.tags.length > SESSION_METADATA_TAG_LIMIT) {
    return `Use at most ${SESSION_METADATA_TAG_LIMIT} tags.`;
  }
  const seen = new Set<string>();
  for (const tag of value.tags) {
    if (codepointLength(tag) > SESSION_METADATA_TAG_MAX) {
      return `Each tag must be at most ${SESSION_METADATA_TAG_MAX} characters.`;
    }
    const folded = tag.toLocaleLowerCase();
    if (seen.has(folded)) {
      return `"${tag}" is added twice.`;
    }
    seen.add(folded);
  }
  return null;
}

/** The wire fields a save sends; absent means clear. */
export function normalizeSessionMetadataDraft(draft: SessionMetadataDraft): {
  title: string | null;
  description: string | null;
  tags: string[];
} {
  return normalized(draft);
}

export function isSessionMetadataDraftDirty(
  draft: SessionMetadataDraft,
  metadata: SessionMetadata | null | undefined,
): boolean {
  const current = normalized(draftFromMetadata(metadata));
  const next = normalized(draft);
  return (
    current.title !== next.title ||
    current.description !== next.description ||
    current.tags.length !== next.tags.length ||
    current.tags.some((tag, index) => tag !== next.tags[index])
  );
}

/** Add one tag to a draft, or explain why it cannot be added. */
export function addSessionMetadataTag(
  draft: SessionMetadataDraft,
  raw: string,
): { draft: SessionMetadataDraft; error: string | null } {
  const tag = raw.trim();
  if (tag === '') {
    return { draft, error: 'Enter a tag.' };
  }
  if (codepointLength(tag) > SESSION_METADATA_TAG_MAX) {
    return {
      draft,
      error: `Each tag must be at most ${SESSION_METADATA_TAG_MAX} characters.`,
    };
  }
  if (draft.tags.length >= SESSION_METADATA_TAG_LIMIT) {
    return { draft, error: `Use at most ${SESSION_METADATA_TAG_LIMIT} tags.` };
  }
  if (draft.tags.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
    return { draft, error: `"${tag}" is already added.` };
  }
  return { draft: { ...draft, tags: [...draft.tags, tag] }, error: null };
}

export function removeSessionMetadataTag(
  draft: SessionMetadataDraft,
  index: number,
): SessionMetadataDraft {
  return { ...draft, tags: draft.tags.filter((_, i) => i !== index) };
}
