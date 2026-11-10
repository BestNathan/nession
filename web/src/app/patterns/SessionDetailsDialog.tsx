import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SessionDetails } from '@/product/session/components/SessionDetails';
import type { DomainState } from '@/product/session/model/domainState';
import type { Session } from '@/types';

/**
 * The row menu's details surface.
 *
 * It reads the chosen Session without changing the current selection: the
 * dialog owns its own target, while the terminal and Workspace keep the
 * Session the user was already working in. `SessionDetails` and its
 * `SessionMetadataSection` remain the owners of runtime facts and the
 * Agent-persisted title/description/tags.
 */
export function SessionDetailsDialog({
  session,
  state,
  editing,
  onClose,
}: {
  session: Session | null;
  state: DomainState | null;
  editing: boolean;
  onClose: () => void;
}) {
  if (!session || !state) {
    return null;
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="session-details-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Session details' : 'Session details'}</DialogTitle>
          <DialogDescription>
            Session work context. The tmux name and Session ID never change here.
          </DialogDescription>
        </DialogHeader>
        <SessionDetails session={session} state={state} initialEditing={editing} />
      </DialogContent>
    </Dialog>
  );
}
