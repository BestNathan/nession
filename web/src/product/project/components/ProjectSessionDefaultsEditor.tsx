import { useMemo } from 'react';
import { EnvFileMultiSelect } from '@/capabilities/env';
import { FormField, FormSection } from '@/components/ui/configuration-form';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { EnvFileInfo, EnvFileRef } from '@/types';
import type { ProjectDraft } from '@/product/project/types';

/**
 * The Project's ordered Server ENV references (#3649).
 *
 * The Project declares names only: the global ENV Library owns every file and
 * its values, and a new Session resolves those references into its own
 * binding. Reordering here changes the declaration order later Sessions
 * inherit; it never rebinds an existing Session.
 */
export function ProjectSessionDefaultsEditor({
  draft,
  onChange,
  envFiles,
  envFilesState,
  disabled,
  idPrefix,
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  envFiles: EnvFileInfo[];
  envFilesState: 'loading' | 'ready' | 'error';
  disabled: boolean;
  idPrefix: string;
}) {
  const serverFiles = useMemo(
    () => envFiles.filter((file) => file.source === 'server'),
    [envFiles],
  );
  const selected = useMemo<EnvFileRef[]>(
    () =>
      draft.envProfileIds.map((name) => ({
        name,
        source: 'server' as const,
      })),
    [draft.envProfileIds],
  );
  const catalogReady = envFilesState === 'ready';
  const missing = catalogReady
    ? selected.filter((ref) => !serverFiles.some((file) => file.name === ref.name))
    : [];

  return (
    <FormSection
      title="Session defaults"
      description="Optional. New Sessions in this Project inherit these Server ENV files in order unless they choose another selection."
      testId={`${idPrefix}-session-defaults`}
    >
      <FormField
        label="Default Environment"
        description="Server ENV files only. ENV contents are never shown here; the Session owns the materialized binding."
        error={
          missing.length > 0 ? (
            <span data-testid={`${idPrefix}-env-defaults-missing`}>
              {missing.length === 1
                ? `${missing[0].name} is not in the ENV Library.`
                : `${missing.length} references are not in the ENV Library.`}{' '}
              Remove the missing reference or restore the file before creating a
              Session from these defaults.
            </span>
          ) : undefined
        }
      >
        <EnvFileMultiSelect
          files={serverFiles}
          selected={selected}
          onChange={(next) =>
            onChange({
              ...draft,
              envProfileIds: next.map((ref) => ref.name),
            })
          }
          disabled={disabled}
          catalogReady={catalogReady}
          emptyLabel={
            envFilesState === 'loading'
              ? 'Loading ENV files…'
              : envFilesState === 'error'
                ? 'ENV Library unavailable — reopen settings to retry'
                : 'No Server ENV files — create one in Environment'
          }
          reorderable
          listClassName="h-40"
        />
      </FormField>
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        Later files win. Changing these defaults affects future Sessions only.
      </p>
    </FormSection>
  );
}
