import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * The dirty-leave confirmation (#1202 §6), shared by both experiences so the
 * wording has one owner. Rendered by the layouts; the decision to open it
 * lives in `useEnvironmentScreen`.
 */
export function EnvironmentGuardDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Mount the dialog only while it is open. Opening the guard again before an
  // exit animation finishes re-inserts Radix's overlay after the dialog
  // content, which leaves the overlay above the buttons and intercepts every
  // click. A confirmation does not need an exit animation; a fresh portal per
  // open keeps the overlay/content order stable.
  if (!open) {
    return null;
  }
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            This environment has unsaved changes. Leaving now discards them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="env-guard-cancel">Keep editing</AlertDialogCancel>
          <AlertDialogAction data-testid="env-guard-confirm" onClick={onConfirm}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
