import { Input } from '@/components/ui/input';
import {
  FormField,
  FormGrid,
  FormSection,
  FormSurface,
} from '@/components/ui/configuration-form';
import { Textarea } from '@/components/ui/textarea';
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
    <FormSection title="Identity">
      <FormField id={`${idPrefix}-name`} label="Name">
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="Nession"
          disabled={disabled}
          autoComplete="off"
        />
      </FormField>
      <FormField id={`${idPrefix}-description`} label="Description (optional)">
        <Textarea
          id={`${idPrefix}-description`}
          value={draft.description ?? ''}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
          disabled={disabled}
          rows={2}
        />
      </FormField>
    </FormSection>
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
    <FormSection
      title="Git source"
      description="Optional. The Project declares the source; the Session checks it out."
    >
      <FormGrid>
        <FormField id={`${idPrefix}-repo`} label="Git repository URL (optional)">
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
        </FormField>
        <FormField id={`${idPrefix}-ref`} label="Branch or full commit SHA">
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
        </FormField>
      </FormGrid>
    </FormSection>
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
    <FormSection title="Image">
      <FormField
        id={`${idPrefix}-digest`}
        label="Image digest reference (optional)"
        description="A reference only. The Project never owns the image bytes."
      >
        <Input
          id={`${idPrefix}-digest`}
          value={draft.image_digest ?? ''}
          onChange={(event) => onChange({ ...draft, image_digest: event.target.value })}
          placeholder="sha256:<64 lowercase hex>"
          disabled={disabled}
          autoComplete="off"
        />
      </FormField>
    </FormSection>
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
    <FormSurface>
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
    </FormSurface>
  );
}
