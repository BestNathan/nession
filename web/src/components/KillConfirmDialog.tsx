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
import { Input } from './ui/input';
import { Label } from './ui/label';
import type { Session } from '../types';
import { sessionsApi } from '@/features/sessions';
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');

  const resetState = useCallback(() => {
    setLoading(false);
    setError(null);
    setConfirmName('');
  }, []);
  useDialogReset(isOpen, resetState);

  if (!session) {return null;}

  // Killing a session is irreversible, so the name must be typed out in full
  // before the action unlocks. Trimmed so trailing whitespace (easy to pick up
  // when copying the name) isn't a silent mismatch.
  const nameMatches = confirmName.trim() === session.session_name;
  const canConfirm = nameMatches && !loading;

  const handleConfirm = async () => {
    if (!canConfirm) {return;}
    setLoading(true);
    setError(null);
    try {
      const result = await sessionsApi.killSession(session.session_id);
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
            This will terminate session{' '}
            <strong className="text-foreground">{session.session_name}</strong> on agent{' '}
            <strong className="text-foreground">{session.agent_id}</strong> and cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="kill-confirm-name" className="text-sm font-normal">
            Type{' '}
            <span className="font-mono font-medium text-foreground select-all">
              {session.session_name}
            </span>{' '}
            to confirm
          </Label>
          <Input
            id="kill-confirm-name"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleConfirm();
              }
            }}
            placeholder={session.session_name}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={loading}
            aria-invalid={confirmName.length > 0 && !nameMatches}
          />
          {confirmName.length > 0 && !nameMatches && (
            <p className="text-xs text-muted-foreground">
              Name doesn&apos;t match yet.
            </p>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {loading ? 'Killing...' : 'Kill Session'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
