import { useState, useCallback } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import type { Session } from '../types';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDialogReset } from '../hooks/useDialogReset';

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

  const resetState = useCallback(() => {
    setLoading(false);
    setError(null);
  }, []);
  useDialogReset(isOpen, resetState);

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
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Kill Session</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to kill session{' '}
            <strong>{session.session_name}</strong> on agent{' '}
            <strong>{session.agent_id}</strong>?
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={loading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {loading ? 'Killing...' : 'Kill Session'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
