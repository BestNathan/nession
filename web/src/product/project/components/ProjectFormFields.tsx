import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { Agent } from '@/types';
import type { ProjectDraft } from '@/product/project/types';
import { ProjectLocationsEditor } from './ProjectLocationsEditor';

function ProjectIdentityFields({
  draft,
  onChange,
  disabled,
  idPrefix,
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="Nession"
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-description`}>Description (optional)</Label>
        <Textarea
          id={`${idPrefix}-description`}
          value={draft.description ?? ''}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
          disabled={disabled}
          rows={2}
        />
      </div>
    </>
  );
}

function ProjectSourceFields({
  draft,
  onChange,
  disabled,
  idPrefix,
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-repo`}>Git repository URL (optional)</Label>
        <Input
          id={`${idPrefix}-repo`}
          value={draft.source?.repository_url ?? ''}
          onChange={(event) =>
            onChange({
              ...draft,
              source: { repository_url: event.target.value, ref: draft.source?.ref ?? '' },
            })
          }
          placeholder="https://github.com/owner/repo.git"
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-ref`}>Branch or full commit SHA</Label>
        <Input
          id={`${idPrefix}-ref`}
          value={draft.source?.ref ?? ''}
          onChange={(event) =>
            onChange({
              ...draft,
              source: {
                repository_url: draft.source?.repository_url ?? '',
                ref: event.target.value,
              },
            })
          }
          placeholder="main"
          disabled={disabled || !draft.source?.repository_url.trim()}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

function ProjectImageField({
  draft,
  onChange,
  disabled,
  idPrefix,
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${idPrefix}-digest`}>Image digest reference (optional)</Label>
      <Input
        id={`${idPrefix}-digest`}
        value={draft.image_digest ?? ''}
        onChange={(event) => onChange({ ...draft, image_digest: event.target.value })}
        placeholder="sha256:<64 lowercase hex>"
        disabled={disabled}
        autoComplete="off"
      />
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        A reference only. The Project never owns the image bytes.
      </p>
    </div>
  );
}

export function ProjectFormFields({
  draft,
  onChange,
  agents,
  disabled,
  idPrefix,
  locationsLayout = 'responsive',
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  agents: Agent[];
  disabled: boolean;
  idPrefix: string;
  locationsLayout?: 'responsive' | 'stacked';
}) {
  return (
    <div className="flex flex-col gap-4">
      <ProjectIdentityFields
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        idPrefix={idPrefix}
      />
      <ProjectSourceFields
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        idPrefix={idPrefix}
      />
      <ProjectLocationsEditor
        draft={draft}
        onChange={onChange}
        agents={agents}
        disabled={disabled}
        idPrefix={idPrefix}
        layout={locationsLayout}
      />
      <ProjectImageField
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        idPrefix={idPrefix}
      />
    </div>
  );
}
