// web/src/product/session/hooks/useSessionMetadataEditor.ts
//
// The details editor's state machine (#2789): view/edit, a draft pinned to the
// revision it was read from, tag entry, saving, and the truthful outcome of a
// failed save. Kept out of the component so the JSX stays presentational and
// the conflict rules are testable without a DOM.
import { useEffect, useState } from 'react';
import {
  loadSessionMetadata,
  saveSessionMetadata,
  type SessionMetadataEntry,
} from '@/product/session/state/metadata';
import {
  addSessionMetadataTag,
  codepointLength,
  draftFromMetadata,
  isSessionMetadataDraftDirty,
  normalizeSessionMetadataDraft,
  removeSessionMetadataTag,
  SESSION_METADATA_DESCRIPTION_MAX,
  SESSION_METADATA_TITLE_MAX,
  validateSessionMetadataDraft,
  type SessionMetadataDraft,
} from '@/product/session/model/sessionMetadata';

export type SessionMetadataNotice =
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; message: string };

export interface SessionMetadataEditor {
  editing: boolean;
  draft: SessionMetadataDraft;
  tagInput: string;
  tagError: string | null;
  saving: boolean;
  notice: SessionMetadataNotice | null;
  dirty: boolean;
  titleInvalid: boolean;
  descriptionInvalid: boolean;
  setDraft: (next: SessionMetadataDraft) => void;
  setTagInput: (value: string) => void;
  startEditing: () => void;
  cancelEditing: () => void;
  addTag: () => void;
  removeTag: (index: number) => void;
  save: () => Promise<void>;
  reloadRemote: () => Promise<void>;
}

type SaveOutcome =
  | {
      kind: 'success';
      draft: SessionMetadataDraft;
      baseRevision: number;
      notice: SessionMetadataNotice;
    }
  | { kind: 'refused'; notice: SessionMetadataNotice };

/** Validate and send one replacement; the hook applies the outcome. */
async function performSave(
  sessionId: string,
  draft: SessionMetadataDraft,
  tagInput: string,
  baseRevision: number,
): Promise<SaveOutcome> {
  if (tagInput.trim() !== '') {
    return {
      kind: 'refused',
      notice: {
        kind: 'error',
        message: 'Add the tag you are typing, or clear the tag field before saving.',
      },
    };
  }
  const invalid = validateSessionMetadataDraft(draft);
  if (invalid !== null) {
    return { kind: 'refused', notice: { kind: 'error', message: invalid } };
  }
  const normalized = normalizeSessionMetadataDraft(draft);
  const response = await saveSessionMetadata(sessionId, {
    title: normalized.title,
    description: normalized.description,
    tags: normalized.tags,
    expectedRevision: baseRevision,
  });
  if (response.success && response.metadata) {
    return {
      kind: 'success',
      draft: draftFromMetadata(response.metadata),
      baseRevision: response.metadata.revision,
      notice: {
        kind: 'success',
        message: 'Session details saved. The tmux name and Session ID are unchanged.',
      },
    };
  }
  if (response.error_kind === 'conflict') {
    // Keep the draft and the revision it was based on. The user decides
    // whether to discard it; a stale save is never replayed automatically.
    return {
      kind: 'refused',
      notice: {
        kind: 'conflict',
        message:
          'Another client saved a newer revision of this Session. Your draft is still here.',
      },
    };
  }
  return {
    kind: 'refused',
    notice: {
      kind: 'error',
      message: response.error ?? 'Session details could not be saved.',
    },
  };
}

export function useSessionMetadataEditor(
  sessionId: string,
  entry: SessionMetadataEntry,
): SessionMetadataEditor {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SessionMetadataDraft>(() =>
    draftFromMetadata(entry.metadata),
  );
  const [baseRevision, setBaseRevision] = useState(entry.metadata?.revision ?? 0);
  const [tagInput, setTagInput] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<SessionMetadataNotice | null>(null);

  // A different Session is a different work context: never carry the previous
  // Session's draft, conflict banner or success notice across.
  useEffect(() => {
    setEditing(false);
    setDraft(draftFromMetadata(null));
    setBaseRevision(0);
    setTagInput('');
    setTagError(null);
    setNotice(null);
    setSaving(false);
  }, [sessionId]);

  // Load the cache's answer into the read view. Never while editing: a
  // background refresh must not overwrite keystrokes.
  useEffect(() => {
    if (!editing && entry.status === 'loaded') {
      setDraft(draftFromMetadata(entry.metadata));
      setBaseRevision(entry.metadata?.revision ?? 0);
    }
  }, [editing, entry.metadata, entry.status]);

  const startEditing = () => {
    setDraft(draftFromMetadata(entry.metadata));
    setBaseRevision(entry.metadata?.revision ?? 0);
    setTagInput('');
    setTagError(null);
    setNotice(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setDraft(draftFromMetadata(entry.metadata));
    setTagInput('');
    setTagError(null);
    setNotice(null);
    setEditing(false);
  };

  const addTag = () => {
    const result = addSessionMetadataTag(draft, tagInput);
    setTagError(result.error);
    if (result.error === null) {
      setDraft(result.draft);
      setTagInput('');
    }
  };

  const removeTag = (index: number) => {
    setDraft((current) => removeSessionMetadataTag(current, index));
    setTagError(null);
  };

  const save = async () => {
    setTagError(null);
    setSaving(true);
    const outcome = await performSave(sessionId, draft, tagInput, baseRevision);
    setSaving(false);
    setNotice(outcome.notice);
    if (outcome.kind === 'success') {
      setDraft(outcome.draft);
      setBaseRevision(outcome.baseRevision);
      setEditing(false);
    }
  };

  const reloadRemote = async () => {
    setSaving(true);
    const next = await loadSessionMetadata(sessionId, { force: true });
    setSaving(false);
    if (next.status !== 'loaded') {
      setNotice({
        kind: 'error',
        message: next.error ?? 'The latest Session details could not be loaded.',
      });
      return;
    }
    setDraft(draftFromMetadata(next.metadata));
    setBaseRevision(next.metadata?.revision ?? 0);
    setTagInput('');
    setTagError(null);
    setEditing(false);
    setNotice(null);
  };

  return {
    editing,
    draft,
    tagInput,
    tagError,
    saving,
    notice,
    dirty: isSessionMetadataDraftDirty(draft, entry.metadata) || tagInput.trim() !== '',
    titleInvalid: codepointLength(draft.title.trim()) > SESSION_METADATA_TITLE_MAX,
    descriptionInvalid:
      codepointLength(draft.description.trim()) > SESSION_METADATA_DESCRIPTION_MAX,
    setDraft,
    setTagInput: (value: string) => {
      setTagInput(value);
      setTagError(null);
    },
    startEditing,
    cancelEditing,
    addTag,
    removeTag,
    save,
    reloadRemote,
  };
}
