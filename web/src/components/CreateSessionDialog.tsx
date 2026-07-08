import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import type { Agent, EnvFileInfo, EnvFileRef } from '../types';
import type { WebSocketService } from '../services/websocket';
import { EnvFileMultiSelect } from './env/EnvFileMultiSelect';

interface CreateSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  wsService: WebSocketService;
  agents: Agent[];
  preselectedAgentId?: string | null;
  onCreated: () => void;
}

function AgentSelect({
  agents,
  value,
  onChange,
  disabled,
}: {
  agents: Agent[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="agent">Agent</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v)} disabled={disabled}>
        <SelectTrigger id="agent">
          <SelectValue placeholder="Select an agent" />
        </SelectTrigger>
        <SelectContent>
          {agents.map((agent) => (
            <SelectItem key={agent.agent_id} value={agent.agent_id}>
              {agent.hostname} ({agent.agent_id})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function CreateSessionDialog({
  isOpen,
  onClose,
  wsService,
  agents,
  preselectedAgentId,
  onCreated,
}: CreateSessionDialogProps) {
  const [agentId, setAgentId] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [envFiles, setEnvFiles] = useState<EnvFileInfo[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<EnvFileRef[]>([]);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const onlineAgents = useMemo(() => agents.filter((a) => a.status === 'online'), [agents]);

  useEffect(() => {
    if (isOpen) {
      setAgentId(preselectedAgentId ?? (onlineAgents.length > 0 ? onlineAgents[0].agent_id : ''));
      setSessionName('');
      setLoading(false);
      setError(null);
      setSelectedEnv([]);
      // Load available env files (optional selection — failure is non-fatal).
      wsService
        .listEnvFiles()
        .then((resp) => setEnvFiles(resp.files))
        .catch(() => setEnvFiles([]));
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
    // onlineAgents derived from agents — stable across renders when agents unchanged
  }, [isOpen, preselectedAgentId, onlineAgents, wsService]);

  const validateName = (name: string): string | null => {
    if (!name.trim()) {return 'Session name is required';}
    if (!/^[a-zA-Z0-9_\-.]+$/.test(name.trim())) {
      return 'Only letters, digits, underscores, hyphens, and dots allowed';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameError = validateName(sessionName);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (!agentId) {
      setError('Please select an agent');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await wsService.createSession(agentId, sessionName.trim(), selectedEnv);
      if (result.success) {
        onCreated();
        onClose();
      } else {
        setError(result.error ?? 'Failed to create session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Session</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <AgentSelect agents={onlineAgents} value={agentId} onChange={setAgentId} disabled={loading} />
          <div className="space-y-2">
            <Label htmlFor="name">Session Name</Label>
            <Input
              ref={nameInputRef}
              id="name"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="my-session"
              disabled={loading}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label>Env Files (optional)</Label>
            <EnvFileMultiSelect
              files={envFiles}
              selected={selectedEnv}
              onChange={setSelectedEnv}
              disabled={loading}
              emptyLabel="No env files — create one in Env Files"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !agentId}>
              {loading ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
