import { useState, useEffect, useRef } from 'react';
import type { Agent } from '../types';
import type { WebSocketService } from '../services/websocket';

interface CreateSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  wsService: WebSocketService;
  agents: Agent[];
  preselectedAgentId?: string | null;
  onCreated: () => void;
}

export function CreateSessionModal({
  isOpen,
  onClose,
  wsService,
  agents,
  preselectedAgentId,
  onCreated,
}: CreateSessionModalProps) {
  const [agentId, setAgentId] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const onlineAgents = agents.filter((a) => a.status === 'online');

  useEffect(() => {
    if (isOpen) {
      setAgentId(preselectedAgentId ?? (onlineAgents.length > 0 ? onlineAgents[0].agent_id : ''));
      setSessionName('');
      setLoading(false);
      setError(null);
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen, preselectedAgentId]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const validateName = (name: string): string | null => {
    if (!name.trim()) return 'Session name is required';
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(name.trim())) {
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
      const result = await wsService.createSession(agentId, sessionName.trim());
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Create Session</h3>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label htmlFor="agent-select">Agent</label>
            <select
              id="agent-select"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={loading}
            >
              {onlineAgents.map((agent) => (
                <option key={agent.agent_id} value={agent.agent_id}>
                  {agent.hostname} ({agent.agent_id})
                </option>
              ))}
            </select>
          </div>
          <div className="modal-field">
            <label htmlFor="session-name">Session Name</label>
            <input
              ref={nameInputRef}
              id="session-name"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="my-session"
              disabled={loading}
              autoComplete="off"
            />
          </div>
          {error && <p className="modal-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-modal-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn-modal-confirm" disabled={loading || !agentId}>
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
