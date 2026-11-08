// web/src/product/session/hooks/useSessionMetadataEditor.ts
//
// The details editor's state machine (#2789): view/edit, a draft pinned to the
// revision it was read from, tag entry, saving, and the truthful outcome of a
// failed save. Kept out of the component so the JSX stays presentational and
// the conflict rules are testable without a DOM.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

interface EditorState {
  editing: boolean;
  draft: SessionMetadataDraft;
  baseRevision: number;
  tagInput: string;
  tagError: string | null;
  saving: boolean;
  notice: SessionMetadataNotice | null;
  setEditing: (value: boolean) => void;
  setDraft: (next: SessionMetadataDraft) => void;
  setBaseRevision: (value: number) => void;
  setTagInput: (value: string) => void;
  setTagError: (value: string | null) => void;
  setSaving: (value: boolean) => void;
  setNotice: (value: SessionMetadataNotice | null) => void;
  sessionIdRef: { current: string };
  generationRef: { current: number };
  startEditing: () => void;
  cancelEditing: () => void;
  addTag: () => void;
  removeTag: (index: number) => void;
}

/**
 * The editor's mutable state plus its Session-change reset.
 *
 * Every asynchronous completion is fenced by both the Session it was started
 * for and an operation generation. `sessionIdRef` is updated in the layout
 * effect before paint, so a save/reload started for A can never apply its
 * state to B after a selection change. The generation also makes the newest
 * operation on one Session the only writer, and the unmount effect invalidates
 * late completions.
 */
function useEditorState(sessionId: string, entry: SessionMetadataEntry): EditorState {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SessionMetadataDraft>(() =>
    draftFromMetadata(entry.metadata),
  );
  const [baseRevision, setBaseRevision] = useState(entry.metadata?.revision ?? 0);
  const [tagInput, setTagInput] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<SessionMetadataNotice | null>(null);
  const sessionIdRef = useRef(sessionId);
  const generationRef = useRef(0);

  // A different Session is a different work context: never carry the previous
  // Session's draft, conflict banner or success notice across.
  useLayoutEffect(() => {
    sessionIdRef.current = sessionId;
    generationRef.current += 1;
    setEditing(false);
    setDraft(draftFromMetadata(null));
    setBaseRevision(0);
    setTagInput('');
    setTagError(null);
    setNotice(null);
    setSaving(false);
  }, [sessionId]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
    };
  }, []);

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

  return {
    editing,
    draft,
    baseRevision,
    tagInput,
    tagError,
    saving,
    notice,
    setEditing,
    setDraft,
    setBaseRevision,
    setTagInput,
    setTagError,
    setSaving,
    setNotice,
    sessionIdRef,
    generationRef,
    startEditing,
    cancelEditing,
    addTag,
    removeTag,
  };
}

export function useSessionMetadataEditor(
  sessionId: string,
  entry: SessionMetadataEntry,
): SessionMetadataEditor {
  const state = useEditorState(sessionId, entry);

  const save = async () => {
    state.setTagError(null);
    const requestSessionId = sessionId;
    const generation = state.generationRef.current + 1;
    state.generationRef.current = generation;
    state.setSaving(true);
    const outcome = await performSave(sessionId, state.draft, state.tagInput, state.baseRevision);
    // The Session may have changed (or a newer save may own this editor)
    // while the Agent answered. The cache write is already keyed to the
    // request's Session; only the editor state belongs to this generation.
    if (state.sessionIdRef.current !== requestSessionId ||
      state.generationRef.current !== generation) {
      return;
    }
    state.setSaving(false);
    state.setNotice(outcome.notice);
    if (outcome.kind === 'success') {
      state.setDraft(outcome.draft);
      state.setBaseRevision(outcome.baseRevision);
      state.setEditing(false);
    }
  };

  const reloadRemote = async () => {
    const requestSessionId = sessionId;
    const generation = state.generationRef.current + 1;
    state.generationRef.current = generation;
    state.setSaving(true);
    const next = await loadSessionMetadata(sessionId, { force: true });
    if (state.sessionIdRef.current !== requestSessionId ||
      state.generationRef.current !== generation) {
      return;
    }
    state.setSaving(false);
    if (next.status !== 'loaded') {
      state.setNotice({
        kind: 'error',
        message: next.error ?? 'The latest Session details could not be loaded.',
      });
      return;
    }
    state.setDraft(draftFromMetadata(next.metadata));
    state.setBaseRevision(next.metadata?.revision ?? 0);
    state.setTagInput('');
    state.setTagError(null);
    state.setEditing(false);
    state.setNotice(null);
  };

  return {
    editing: state.editing,
    draft: state.draft,
    tagInput: state.tagInput,
    tagError: state.tagError,
    saving: state.saving,
    notice: state.notice,
    dirty: isSessionMetadataDraftDirty(state.draft, entry.metadata) ||
      state.tagInput.trim() !== '',
    titleInvalid:
      codepointLength(state.draft.title.trim()) > SESSION_METADATA_TITLE_MAX,
    descriptionInvalid:
      codepointLength(state.draft.description.trim()) > SESSION_METADATA_DESCRIPTION_MAX,
    setDraft: state.setDraft,
    setTagInput: (value: string) => {
      state.setTagInput(value);
      state.setTagError(null);
    },
    startEditing: state.startEditing,
    cancelEditing: state.cancelEditing,
    addTag: state.addTag,
    removeTag: state.removeTag,
    save,
    reloadRemote,
  };
}
