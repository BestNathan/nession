import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import type { Session } from '../types';
import { useWebSocket } from '../hooks/useWebSocket';

interface KillConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  onKilled: () => void;
}

export function KillConfirmDialog({
  isOpen,
  onClose,
  session,
  onKilled,
}: KillConfirmDialogProps) {
  const wsService = useWebSocket();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLoading(false);
      setError(null);
    }
  }, [isOpen]);

  if (!session) {return null;}

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await wsService.killSession(session.session_id);
      if (result.success) {
        onKilled();
        onClose();
      } else {
        setError(result.error ?? 'Failed to kill session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to kill session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Kill Session</DialogTitle>
          <DialogDescription>
            Are you sure you want to kill session{' '}
            <strong>{session.session_name}</strong> on agent{' '}
            <strong>{session.agent_id}</strong>?
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading}>
            {loading ? 'Killing...' : 'Kill Session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
