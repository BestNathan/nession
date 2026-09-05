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
import type { Agent } from '../types';
import { agentDisplayName } from '../lib/format';
import { agentsApi } from '@/features/agents';
import { useDialogReset } from '../hooks/useDialogReset';

interface DeleteAgentConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agent: Agent | null;
  onDeleted: () => void;
}

export function DeleteAgentConfirmDialog({
  isOpen,
  onClose,
  agent,
  onDeleted,
}: DeleteAgentConfirmDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');

  const resetState = useCallback(() => {
    setLoading(false);
    setError(null);
    setConfirmName('');
  }, []);
  useDialogReset(isOpen, resetState);

  if (!agent) {return null;}

  const display = agentDisplayName(agent);
  const hostname = agent.hostname;
  const trimmed = confirmName.trim();
  // User may type either the display name (or hostname fallback) or the raw hostname.
  const nameMatches = trimmed === display || trimmed === hostname;
  const canConfirm = nameMatches && !loading;

  const handleConfirm = async () => {
    if (!canConfirm) {return;}
    setLoading(true);
    setError(null);
    try {
      await agentsApi.deleteAgent(agent.agent_id);
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete agent');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Agent</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently remove agent{' '}
            <strong className="text-foreground">{display}</strong>
            {display !== hostname && (
              <> (<span className="font-mono">{hostname}</span>)</>
            )}{' '}
            and all its sessions from the server. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="delete-agent-confirm-name" className="text-sm font-normal">
            Type{' '}
            <span className="font-mono font-medium text-foreground select-all">
              {display}
            </span>{' '}
            or{' '}
            <span className="font-mono font-medium text-foreground select-all">
              {hostname}
            </span>{' '}
            to confirm
          </Label>
          <Input
            id="delete-agent-confirm-name"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleConfirm();
              }
            }}
            placeholder={display}
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
            {loading ? 'Deleting...' : 'Delete Agent'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
