import { useState, useRef, useCallback } from 'react';
import type { Agent } from '../types';
import { getWebSocketService } from '../services/websocket';
import { agentDisplayName } from '../lib/format';

/** Hook encapsulating the rename-in-place state machine for an agent card. */
export function useAgentRename(
  agent: Agent,
  onRename?: (agent: Agent) => void,
) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(agentDisplayName(agent));
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setEditValue(agentDisplayName(agent));
      setEditing(true);
      setTimeout(() => inputRef.current?.select(), 0);
    },
    [agent],
  );

  const save = useCallback(async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === agentDisplayName(agent)) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      const ws = getWebSocketService();
      if (!ws) {throw new Error('Not connected');}
      const updated = await ws.renameAgent(agent.agent_id, trimmed);
      onRename?.(updated);
    } catch (err) {
      console.error('Failed to rename agent:', err);
      setEditValue(agentDisplayName(agent));
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }, [editValue, agent, onRename]);

  const cancel = useCallback(() => {
    setEditValue(agentDisplayName(agent));
    setEditing(false);
  }, [agent]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        void save();
      } else if (e.key === 'Escape') {
        cancel();
      }
    },
    [save, cancel],
  );

  const clearName = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setSaving(true);
      try {
        const ws = getWebSocketService();
        if (!ws) {throw new Error('Not connected');}
        const updated = await ws.renameAgent(agent.agent_id, null);
        onRename?.(updated);
      } catch (err) {
        console.error('Failed to clear agent name:', err);
      } finally {
        setSaving(false);
      }
    },
    [agent, onRename],
  );

  return {
    editing, editValue, setEditValue, saving, inputRef,
    startEdit, save, cancel, handleKeyDown, clearName,
    displayName: agentDisplayName(agent),
    isCustomName: !!agent.display_name,
  };
}
