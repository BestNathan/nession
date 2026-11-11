// The Session Workspace's work-context section (#2789).
//
// Read view, contained editor, and the distinct truthful states: loading,
// legacy/absent metadata, unavailable Agent, saving, success and revision
// conflict. The Session identity (tmux name / session_id) is never part of the
// editor; the title is only the display alias.
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  FormActions,
  FormField,
  FormSection,
} from '@/components/ui/configuration-form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { Session } from '@/types';
import {
  useSessionMetadataEditor,
  type SessionMetadataEditor,
} from '@/product/session/hooks/useSessionMetadataEditor';
import type { SessionMetadataEntry } from '@/product/session/state/metadata';
import {
  codepointLength,
  SESSION_METADATA_DESCRIPTION_MAX,
  SESSION_METADATA_TAG_LIMIT,
  SESSION_METADATA_TAG_MAX,
  SESSION_METADATA_TITLE_MAX,
} from '@/product/session/model/sessionMetadata';

function SessionMetadataView({ entry }: { entry: SessionMetadataEntry }) {
  const metadata = entry.metadata;
  return (
    <div data-testid="session-metadata-view" className="flex flex-col gap-3">
      {metadata?.description ? (
        <p data-testid="session-metadata-description" className={chromeSansRole('body')}>
          {metadata.description}
        </p>
      ) : (
        <p
          data-testid="session-metadata-description-empty"
          className={cn('text-muted-foreground', chromeSansRole('body'))}
        >
          {metadata && metadata.revision > 0
            ? 'No description yet.'
            : 'This Session has no saved details yet.'}
        </p>
      )}
      <div data-testid="session-metadata-tags-view" className="flex flex-wrap gap-1.5">
        {metadata && metadata.tags.length > 0 ? (
          metadata.tags.map((tag) => (
            <Badge key={tag} variant="secondary" data-testid="session-metadata-tag">
              #{tag}
            </Badge>
          ))
        ) : (
          <span className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            No tags
          </span>
        )}
      </div>
    </div>
  );
}

function SessionMetadataTagsEditor({ editor }: { editor: SessionMetadataEditor }) {
  return (
    <FormField
      id="session-metadata-tag-input"
      label="Tags"
      description={`Up to ${SESSION_METADATA_TAG_LIMIT} tags, ${SESSION_METADATA_TAG_MAX} characters each; duplicates are ignored regardless of case.`}
      error={editor.tagError}
      errorTestId="session-metadata-tag-error"
    >
      <div data-testid="session-metadata-tags-editor" className="flex flex-wrap gap-1.5">
        {editor.draft.tags.length > 0 ? (
          editor.draft.tags.map((tag, index) => (
            <Badge key={`${tag}-${index}`} variant="secondary">
              #{tag}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-4"
                disabled={editor.saving}
                data-testid={`session-metadata-remove-tag-${index}`}
                aria-label={`Remove tag ${tag}`}
                onClick={() => editor.removeTag(index)}
              >
                <span aria-hidden="true">×</span>
              </Button>
            </Badge>
          ))
        ) : (
          <span className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            No tags
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          id="session-metadata-tag-input"
          aria-label="Add tag"
          data-testid="session-metadata-tag-input"
          value={editor.tagInput}
          disabled={editor.saving}
          placeholder="Add a tag"
          onChange={(event) => editor.setTagInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              editor.addTag();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          data-testid="session-metadata-add-tag"
          disabled={editor.saving}
          onClick={() => editor.addTag()}
        >
          Add
        </Button>
      </div>
    </FormField>
  );
}

function SessionMetadataEditorForm({
  editor,
  sessionName,
}: {
  editor: SessionMetadataEditor;
  sessionName: string;
}) {
  return (
    <div data-testid="session-metadata-editor" className="flex flex-col gap-3">
      <FormField
        id="session-metadata-title"
        label="Title"
        labelAction={
          <span className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>
            {codepointLength(editor.draft.title.trim())}/{SESSION_METADATA_TITLE_MAX}
          </span>
        }
        description="Shown in navigation. The tmux name is not renamed."
      >
        <Input
          id="session-metadata-title"
          data-testid="session-metadata-title-input"
          value={editor.draft.title}
          disabled={editor.saving}
          aria-invalid={editor.titleInvalid}
          placeholder={sessionName}
          onChange={(event) =>
            editor.setDraft({ ...editor.draft, title: event.target.value })
          }
        />
      </FormField>

      <FormField
        id="session-metadata-description"
        label="Description"
        labelAction={
          <span className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>
            {codepointLength(editor.draft.description.trim())}/
            {SESSION_METADATA_DESCRIPTION_MAX}
          </span>
        }
      >
        <Textarea
          id="session-metadata-description"
          data-testid="session-metadata-description-input"
          value={editor.draft.description}
          disabled={editor.saving}
          aria-invalid={editor.descriptionInvalid}
          placeholder="What is this work about?"
          className="min-h-24"
          onChange={(event) =>
            editor.setDraft({ ...editor.draft, description: event.target.value })
          }
        />
      </FormField>

      <SessionMetadataTagsEditor editor={editor} />

      {editor.notice && editor.notice.kind !== 'conflict' ? (
        <p
          role={editor.notice.kind === 'error' ? 'alert' : 'status'}
          data-testid="session-metadata-notice"
          className={cn(
            editor.notice.kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
            chromeSansRole('body'),
          )}
        >
          {editor.notice.message}
        </p>
      ) : null}

      {editor.notice && editor.notice.kind === 'conflict' ? (
        <div
          data-testid="session-metadata-conflict"
          role="alert"
          className="flex flex-col gap-2 rounded-[var(--nession-radius-surface)] bg-destructive/10 px-3 py-2"
        >
          <p className={cn('text-destructive', chromeSansRole('body'))}>
            {editor.notice.message}
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="session-metadata-reload"
              disabled={editor.saving}
              onClick={() => void editor.reloadRemote()}
            >
              Discard draft and load latest
            </Button>
          </div>
        </div>
      ) : null}

      <FormActions>
        <Button
          type="button"
          variant="outline"
          data-testid="session-metadata-cancel"
          disabled={editor.saving}
          onClick={() => editor.cancelEditing()}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="session-metadata-save"
          disabled={editor.saving || !editor.dirty}
          onClick={() => void editor.save()}
        >
          {editor.saving ? 'Saving…' : 'Save'}
        </Button>
      </FormActions>
    </div>
  );
}

export function SessionMetadataSection({
  session,
  entry,
  initialEditing = false,
  editingDisabled = false,
}: {
  session: Session;
  entry: SessionMetadataEntry;
  /** Open directly in the editor (the row menu's Edit details action). */
  initialEditing?: boolean;
  /** Offline/error Agents keep details readable but do not accept edits. */
  editingDisabled?: boolean;
}) {
  const editor = useSessionMetadataEditor(session.session_id, entry);
  const loading = entry.status === 'idle' || entry.status === 'loading';
  const unavailable = entry.status === 'error';
  const initialEditStarted = useRef(false);

  useEffect(() => {
    initialEditStarted.current = false;
  }, [session.session_id, initialEditing]);

  useEffect(() => {
    if (
      !initialEditing ||
      editingDisabled ||
      initialEditStarted.current ||
      entry.status !== 'loaded' ||
      editor.editing
    ) {
      return;
    }
    initialEditStarted.current = true;
    editor.startEditing();
  }, [editingDisabled, editor, entry.status, initialEditing]);

  return (
    <FormSection
      title="Work context"
      level="h3"
      titleId="session-metadata-heading"
      testId="session-metadata"
      action={
        !editor.editing && entry.status === 'loaded' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="session-metadata-edit"
            disabled={editingDisabled}
            title={editingDisabled ? 'Editing is unavailable while the Agent is offline.' : undefined}
            onClick={() => editor.startEditing()}
          >
            Edit details
          </Button>
        ) : null
      }
    >

      {editingDisabled && !editor.editing ? (
        <p
          role="status"
          data-testid="session-metadata-editing-unavailable"
          className={cn('text-muted-foreground', chromeSansRole('body'))}
        >
          Editing is unavailable while the Agent is offline. Details remain readable.
        </p>
      ) : null}

      {loading && !editor.editing ? (
        <p
          role="status"
          data-testid="session-metadata-loading"
          className={cn('text-muted-foreground', chromeSansRole('secondary'))}
        >
          Loading Session details…
        </p>
      ) : null}

      {unavailable && !editor.editing ? (
        <div
          data-testid="session-metadata-error"
          role="alert"
          className="flex flex-col gap-2 rounded-[var(--nession-radius-surface)] bg-destructive/10 px-3 py-2"
        >
          <p className={cn('text-destructive', chromeSansRole('body'))}>
            {entry.error ?? 'Session details are unavailable.'}
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="session-metadata-retry"
              onClick={() => void editor.reloadRemote()}
            >
              Retry
            </Button>
          </div>
        </div>
      ) : null}

      {!editor.editing && (entry.status === 'loaded' || unavailable) ? (
        <SessionMetadataView entry={entry} />
      ) : null}

      {editor.editing ? (
        <SessionMetadataEditorForm editor={editor} sessionName={session.session_name} />
      ) : null}

      {!editor.editing && editor.notice && editor.notice.kind === 'success' ? (
        <p
          role="status"
          data-testid="session-metadata-notice"
          className={cn('text-muted-foreground', chromeSansRole('body'))}
        >
          {editor.notice.message}
        </p>
      ) : null}
    </FormSection>
  );
}
