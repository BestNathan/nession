import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AppPageHeader } from '@/app/patterns/AppPageHeader';
import { AppPopupPortal } from './AppPopupPortal';

/**
 * One App operation depth (#3089).
 *
 * Attach configuration and Session/Project creation are **operations**, not
 * shrunken Web dialogs: a full-height page with exactly one header/Back, one
 * scroll owner in the middle, and a persistent safe-area-aware action footer.
 * The page is an overlay over the mounted shell, so the selected Session and
 * its Terminal are untouched while a draft is edited.
 *
 * It is the shared dialog primitive's `fullscreen` arrangement rather than a
 * second overlay: Escape, focus containment and outside dismissal stay with
 * that one owner.
 *
 * `data-experience="app"` is stated here because the page mounts beside the
 * App root, not inside it: the Experience tokens are emitted under that
 * attribute, and the overlay would otherwise resolve Web's values.
 */
export function AppOperationPage({
  title,
  backLabel,
  onBack,
  children,
  footer,
  testId,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  children: ReactNode;
  footer: ReactNode;
  testId: string;
}) {
  return (
    <AppPopupPortal>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            onBack();
          }
        }}
      >
        <DialogContent
          variant="fullscreen"
          showCloseButton={false}
          data-experience="app"
          data-recipe="operation-surface"
          data-testid={testId}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogHeader
            data-recipe-part="operation-title"
            className="gap-0 border-b-0 bg-background p-0 pr-0"
          >
            <AppPageHeader backLabel={backLabel} onBack={onBack} title={title} />
          </DialogHeader>
          <DialogBody
            data-testid={`${testId}-body`}
            data-recipe-part="operation-body"
            className="flex flex-col gap-[var(--nession-shell-space-3)] px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)]"
          >
            {children}
          </DialogBody>
          <footer
            data-testid={`${testId}-footer`}
            data-recipe-part="operation-actions"
            className={cn(
              'z-10 shrink-0 border-t bg-background px-[var(--nession-shell-space-3)] pt-[var(--nession-shell-space-2)]',
              'pb-[max(var(--nession-shell-space-2),env(safe-area-inset-bottom))]',
            )}
          >
            {footer}
          </footer>
        </DialogContent>
      </Dialog>
    </AppPopupPortal>
  );
}

/**
 * The App quick Attach sheet (#3089).
 *
 * A compact bottom sheet over the mounted Terminal: Session identity, the
 * current connection summary, one primary Attach action and the entry to the
 * full configuration page. It is a Dialog so Escape/outside dismissal and
 * focus containment come from the one primitive the App already uses.
 */
export function AppSheet({
  open,
  onOpenChange,
  title,
  children,
  footer,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer: ReactNode;
  testId: string;
}) {
  return (
    <AppPopupPortal>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          data-experience="app"
          data-testid={testId}
          variant="sheet"
          showCloseButton
        >
          <DialogHeader className="px-[var(--nession-shell-space-3)] pr-12">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-[var(--nession-shell-space-2)] px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)]">
            {children}
          </DialogBody>
          <DialogFooter className="bg-popover px-[var(--nession-shell-space-3)] pt-[var(--nession-shell-space-2)] pb-[max(var(--nession-shell-space-2),env(safe-area-inset-bottom))]">
            {footer}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPopupPortal>
  );
}
