import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import type { EnvFileInfo, EnvFileRef, Session } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { EnvFileMultiSelect } from './EnvFileMultiSelect';

interface AttachEnvDialogProps {
  isOpen: boolean;
  onClose: () => void;
  wsService: WebSocketService;
  session: Session | null;
  /** Called with the env files the user chose; attaches then applies them. */
  onConfirm: (session: Session, envFiles: EnvFileRef[]) => void;
}

/**
 * Secondary attach path: pick env files to apply on attach. The plain "Attach"
 * button stays one-click and env-free; this dialog is only reached via the
 * explicit "Attach with env…" action, so the no-env flow is unchanged (SC3).
 */
export function AttachEnvDialog({
  isOpen,
  onClose,
  wsService,
  session,
  onConfirm,
}: AttachEnvDialogProps) {
  const [files, setFiles] = useState<EnvFileInfo[]>([]);
  const [selected, setSelected] = useState<EnvFileRef[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {return;}
    setSelected([]);
    setLoading(true);
    wsService
      .listEnvFiles()
      .then((resp) => setFiles(resp.files))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to list env files'))
      .finally(() => setLoading(false));
  }, [isOpen, wsService]);

  const handleConfirm = () => {
    if (session) {onConfirm(session, selected);}
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach with Env{session ? `: ${session.session_name}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Selected env files are applied to the session on attach and removed when you detach.
          </p>
          <EnvFileMultiSelect
            files={files}
            selected={selected}
            onChange={setSelected}
            disabled={loading}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm}>
            Attach{selected.length > 0 ? ` with ${selected.length}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
