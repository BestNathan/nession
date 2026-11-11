import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { FilesWebSelection, FilesWebSwitchState } from './useFilesWebSwitchGuard';

/** The one decision before a dirty Web file may be replaced. */
export function FilesWebSwitchDialog({
  selected,
  state,
}: {
  selected: FilesWebSelection | null;
  state: FilesWebSwitchState;
}) {
  const { pending, saving, guardSaving, error, cancel, discard, save } = state;
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) {
          cancel();
        }
      }}
    >
      <AlertDialogContent data-testid="files-web-unsaved-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
          <AlertDialogDescription>
            {pending !== null && selected !== null
              ? `Save your changes to ${selected.filename} before opening ${pending.filename}, or discard them.`
              : 'Save your changes before leaving this file, or discard them.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {saving && !guardSaving ? (
          <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Saving current changes…
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            data-testid="files-web-switch-error"
            className={cn('text-destructive', chromeSansRole('caption'))}
          >
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="files-web-switch-cancel" disabled={guardSaving}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            variant="outline"
            data-testid="files-web-switch-discard"
            disabled={guardSaving || saving}
            onClick={discard}
            className="text-destructive hover:text-destructive"
          >
            {pending !== null ? `Discard and open ${pending.filename}` : 'Discard changes'}
          </Button>
          <Button
            type="button"
            data-testid="files-web-switch-save"
            disabled={guardSaving || saving}
            onClick={() => {
              void save();
            }}
          >
            {guardSaving || saving ? 'Saving…' : 'Save and switch'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
