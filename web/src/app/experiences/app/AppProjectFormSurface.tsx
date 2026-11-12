import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { Button } from '@/components/ui/button';
import { ProjectFormFields } from '@/product/project/components/ProjectFormFields';
import { useProjectDraftForm } from '@/product/project/hooks/useProjectDraftForm';
import type { Agent } from '@/types';
import type { Project } from '@/product/project/types';
import { AppOperationPage } from './AppOperationPage';

/**
 * App Project create/settings (#3089).
 *
 * The same declaration edit as the Web dialog, composed as one full-height
 * operation page: one header/Back, stacked Agent/Directory cards with
 * touch-sized actions, and one anchored save action. Back is the page's only
 * leave; there is no second Cancel with the same meaning.
 */
export function AppProjectFormSurface({
  kind,
  isOpen,
  project,
  agents,
  onClose,
  onChanged,
  onSaved,
}: {
  kind: 'create' | 'settings';
  isOpen: boolean;
  project?: Project | null;
  agents: Agent[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onSaved: (project: Project) => void;
}) {
  const form = useProjectDraftForm({
    kind,
    isOpen,
    project,
    onChanged,
    onSaved,
    onClose,
  });

  if (!isOpen) {
    return null;
  }

  const creating = kind === 'create';
  const title = creating ? 'New Project' : 'Project settings';
  const formId = creating ? 'app-project-create-form' : 'app-project-settings-form';

  return (
    <AppOperationPage
      testId={creating ? 'app-project-create-page' : 'app-project-settings-page'}
      title={title}
      backLabel={creating ? 'Sessions' : 'Project'}
      onBack={onClose}
      footer={
        <Button
          type="button"
          data-testid={creating ? 'project-create-submit' : 'project-settings-submit'}
          disabled={form.busy}
          className="min-h-11 w-full"
          onClick={() => void form.submit()}
        >
          {form.busy
            ? creating
              ? 'Creating…'
              : 'Saving…'
            : creating
              ? 'Create Project'
              : 'Save changes'}
        </Button>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-[var(--nession-shell-space-3)]"
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
        }}
      >
        <ProjectFormFields
          draft={form.draft}
          onChange={form.setDraft}
          agents={agents}
          disabled={form.busy}
          idPrefix={creating ? 'project-create' : 'project-settings'}
          locationsLayout="stacked"
        />
        {form.error ? (
          <p
            className={cn('text-destructive', chromeSansRole('body'))}
            data-testid="project-dialog-error"
          >
            {form.error}
          </p>
        ) : null}
      </form>
    </AppOperationPage>
  );
}
