import { useState, useEffect } from 'react';
import type { Session } from '../types';
import type { WebSocketService } from '../services/websocket';

interface ConfirmKillModalProps {
  isOpen: boolean;
  onClose: () => void;
  wsService: WebSocketService;
  session: Session | null;
  onKilled: () => void;
}

export function ConfirmKillModal({
  isOpen,
  onClose,
  wsService,
  session,
  onKilled,
}: ConfirmKillModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLoading(false);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !session) return null;

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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Kill Session</h3>
        <p className="modal-description">
          Are you sure you want to kill session{' '}
          <strong>{session.session_name}</strong> on agent{' '}
          <strong>{session.agent_id}</strong>?
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn-modal-cancel" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-modal-confirm btn-modal-danger"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? 'Killing...' : 'Kill Session'}
          </button>
        </div>
      </div>
    </div>
  );
}
