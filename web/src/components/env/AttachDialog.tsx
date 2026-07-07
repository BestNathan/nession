import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import type { AttachMode, EnvFileInfo, EnvFileRef, Session } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { EnvFileMultiSelect } from './EnvFileMultiSelect';
import { refKey } from './envRef';
import { loadAttachPrefs, saveAttachPrefs } from '../../services/attachPrefs';

interface AttachDialogProps {
  isOpen: boolean;
  onClose: () => void;
  wsService: WebSocketService;
  session: Session | null;
  /** Called with the chosen mode + env files; the flow performs the attach. */
  onConfirm: (session: Session, mode: AttachMode, envFiles: EnvFileRef[]) => void;
}

// Relay is intentionally omitted: the server's relay attach path is not yet
// wired to return an attach response, so a forced relay would time out. "Auto"
// still falls back to relay internally when P2P is unavailable.
const MODES: { value: AttachMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Try P2P, fall back to relay' },
  { value: 'p2p', label: 'P2P', hint: 'Direct to agent (lower latency)' },
];

/**
 * Unified attach dialog: pick connection mode and (optionally) env files to
 * apply on attach. Pre-fills from the last-used preferences.
 */
export function AttachDialog({ isOpen, onClose, wsService, session, onConfirm }: AttachDialogProps) {
  const [mode, setMode] = useState<AttachMode>('auto');
  const [files, setFiles] = useState<EnvFileInfo[]>([]);
  const [selected, setSelected] = useState<EnvFileRef[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const prefs = loadAttachPrefs();
    // Relay isn't offered as a forced mode (see MODES); coerce any stale
    // stored value back to auto.
    setMode(prefs.mode === 'relay' ? 'auto' : prefs.mode);
    setSelected(prefs.envFiles);
    setLoading(true);
    wsService
      .listEnvFiles()
      .then((resp) => {
        setFiles(resp.files);
        // Drop stale refs that reference files that no longer exist so the
        // user isn't stuck with phantom selections (the multi-select only
        // renders items from the files list — there's no way to deselect a
        // file that isn't visible).
        const validKeys = new Set(resp.files.map((f) => refKey(f)));
        const validSelected = prefs.envFiles.filter((r) => validKeys.has(refKey(r)));
        if (validSelected.length !== prefs.envFiles.length) {
          saveAttachPrefs({ mode: prefs.mode, envFiles: validSelected });
        }
        setSelected(validSelected);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to list env files'))
      .finally(() => setLoading(false));
  }, [isOpen, wsService]);

  const handleConfirm = () => {
    if (session) {
      onConfirm(session, mode, selected);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach{session ? `: ${session.session_name}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Connection Mode</Label>
            <div className="grid grid-cols-2 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMode(m.value)}
                  className={cn(
                    'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
                    mode === m.value
                      ? 'border-primary bg-primary/10'
                      : 'border-input hover:bg-accent/50',
                  )}
                >
                  <span className="text-sm font-medium">{m.label}</span>
                  <span className="text-[10px] text-muted-foreground leading-tight">{m.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Env Files (optional)</Label>
            <p className="text-xs text-muted-foreground">
              Applied to the session on attach and removed when you detach.
            </p>
            <EnvFileMultiSelect
              files={files}
              selected={selected}
              onChange={setSelected}
              disabled={loading}
            />
          </div>
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
