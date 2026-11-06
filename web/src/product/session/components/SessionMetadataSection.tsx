// The Session Workspace's work-context section (#2789).
//
// Read view, contained editor, and the distinct truthful states: loading,
// legacy/absent metadata, unavailable Agent, saving, success and revision
// conflict. The Session identity (tmux name / session_id) is never part of the
// editor; the title is only the display alias.
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="session-metadata-tag-input">Tags</Label>
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
      <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
        Up to {SESSION_METADATA_TAG_LIMIT} tags, {SESSION_METADATA_TAG_MAX} characters each;
        duplicates are ignored regardless of case.
      </p>
      {editor.tagError ? (
        <p
          role="alert"
          data-testid="session-metadata-tag-error"
          className={cn('text-destructive', chromeSansRole('metadata'))}
        >
          {editor.tagError}
        </p>
      ) : null}
    </div>
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
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="session-metadata-title">Title</Label>
          <span className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>
            {codepointLength(editor.draft.title.trim())}/{SESSION_METADATA_TITLE_MAX}
          </span>
        </div>
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
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          Shown in navigation. The tmux name is not renamed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="session-metadata-description">Description</Label>
          <span className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>
            {codepointLength(editor.draft.description.trim())}/
            {SESSION_METADATA_DESCRIPTION_MAX}
          </span>
        </div>
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
      </div>

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

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          data-testid="session-metadata-save"
          disabled={editor.saving || !editor.dirty}
          onClick={() => void editor.save()}
        >
          {editor.saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="session-metadata-cancel"
          disabled={editor.saving}
          onClick={() => editor.cancelEditing()}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function SessionMetadataSection({
  session,
  entry,
}: {
  session: Session;
  entry: SessionMetadataEntry;
}) {
  const editor = useSessionMetadataEditor(session.session_id, entry);
  const loading = entry.status === 'idle' || entry.status === 'loading';
  const unavailable = entry.status === 'error';

  return (
    <section
      data-testid="session-metadata"
      aria-labelledby="session-metadata-heading"
      className="flex flex-col gap-3"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 id="session-metadata-heading" className={chromeSansRole('secondary')}>
          Work context
        </h3>
        {!editor.editing && entry.status === 'loaded' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="session-metadata-edit"
            onClick={() => editor.startEditing()}
          >
            Edit details
          </Button>
        ) : null}
      </div>

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
    </section>
  );
}
