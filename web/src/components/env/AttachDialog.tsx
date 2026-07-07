import { useState, useEffect } from 'react';
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
import type { AttachMode, Session } from '../../types';
import { loadAttachPrefs } from '../../services/attachPrefs';

interface AttachDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  /** Called with the chosen mode; the flow performs the attach. */
  onConfirm: (session: Session, mode: AttachMode) => void;
}

// Relay is intentionally omitted: the server's relay attach path is not yet
// wired to return an attach response, so a forced relay would time out. "Auto"
// still falls back to relay internally when P2P is unavailable.
const MODES: { value: AttachMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Try P2P, fall back to relay' },
  { value: 'p2p', label: 'P2P', hint: 'Direct to agent (lower latency)' },
];

/**
 * Attach dialog: pick connection mode. Pre-fills from the last-used preference.
 */
export function AttachDialog({ isOpen, onClose, session, onConfirm }: AttachDialogProps) {
  const [mode, setMode] = useState<AttachMode>('auto');

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const prefs = loadAttachPrefs();
    // Coerce any stale stored relay value back to auto.
    setMode(prefs.mode === 'relay' ? 'auto' : prefs.mode);
  }, [isOpen]);

  const handleConfirm = () => {
    if (session) {
      onConfirm(session, mode);
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
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm}>
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
