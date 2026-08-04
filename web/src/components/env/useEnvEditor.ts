import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { Agent, EnvFileInfo, EnvFileRef, EnvSource } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { useWebSocket } from '../../hooks/useWebSocket';

/** Inputs for {@link useEnvEditor}. */
export interface EnvEditorOptions {
  wsService?: WebSocketService;
  isOpen: boolean;
  editing: EnvFileInfo | null;
  /** When set, opens a new editor pre-filled from this file's content. */
  cloneFrom?: EnvFileInfo | null;
  agents: Agent[];
  onSaved: () => void;
  onClose: () => void;
}

/** Seed a clone editor with a file's content; on failure the editor opens empty. */
async function loadCloneContent(
  wsService: WebSocketService,
  file: EnvFileInfo,
  onContent: (content: string) => void,
): Promise<void> {
  try {
    const resp = await wsService.getEnvFile({
      name: file.name,
      source: file.source,
      agent_id: file.agent_id,
    });
    if (resp.success) {
      onContent(resp.content ?? '');
    }
  } catch {
    // Not loaded — the clone still opens with the prefilled name/source.
  }
}

/** Form state + load/save behaviour for the env editor dialog. */
export function useEnvEditor({
  wsService: _wsService,
  isOpen,
  editing,
  cloneFrom,
  agents,
  onSaved,
  onClose,
}: EnvEditorOptions) {
  const wsService = useWebSocket(_wsService);
  const [name, setName] = useState('');
  const [source, setSource] = useState<EnvSource>('server');
  const [agentId, setAgentId] = useState('');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hideSecrets, setHideSecrets] = useState(false);

  const isEdit = editing !== null;

  /** Stable ref for agents — avoids resetting form state on realtime agent updates. */
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setError(null);
    setLoading(false);
    if (cloneFrom) {
      setName(`${cloneFrom.name.replace(/\.env$/, '')}-copy.env`);
      setSource(cloneFrom.source);
      setAgentId(cloneFrom.agent_id ?? '');
      setOriginalContent('');
      void loadCloneContent(wsService, cloneFrom, setContent);
      return;
    }
    if (editing) {
      setName(editing.name);
      setSource(editing.source);
      setAgentId(editing.agent_id ?? '');
      setHideSecrets(true);
      wsService
        .getEnvFile({ name: editing.name, source: editing.source, agent_id: editing.agent_id })
        .then((resp) => {
          if (resp.success) {
            setContent(resp.content ?? '');
            setOriginalContent(resp.content ?? '');
            if (resp.in_use_by && resp.in_use_by.length > 0) {
              setError(
                `This file is in use by session(s): ${resp.in_use_by.join(', ')}. Stop the session or detach before editing.`,
              );
            }
          } else {
            setError(resp.error ?? 'Failed to load file');
          }
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load file'));
    } else {
      const firstOnline = agentsRef.current.find((a) => a.status === 'online');
      setName('');
      setSource('server');
      setAgentId(firstOnline ? firstOnline.agent_id : '');
      setContent('');
      setOriginalContent('');
      setHideSecrets(false);
    }
  }, [isOpen, editing, cloneFrom, wsService]);

  const buildRef = (): EnvFileRef => {
    const fileName = name.trim().endsWith('.env') ? name.trim() : `${name.trim()}.env`;
    return { name: fileName, source, agent_id: source === 'agent' ? agentId : undefined };
  };

  const doWrite = async (overwrite: boolean): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const resp = await wsService.writeEnvFile(buildRef(), content, overwrite);
      if (resp.success) {
        if (resp.warnings && resp.warnings.length > 0) {
          toast.warning(`Saved with warnings: ${resp.warnings.join('; ')}`);
        } else {
          toast.success(isEdit ? 'Env file updated' : 'Env file created');
        }
        onSaved();
        onClose();
      } else if (resp.exists) {
        if (window.confirm('File already exists. Overwrite?')) {
          await doWrite(true);
        }
      } else {
        setError(resp.error ?? 'Failed to save file');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save file');
    } finally {
      setLoading(false);
    }
  };

  const submit = () => {
    if (!name.trim()) {
      setError('File name is required');
      return;
    }
    if (source === 'agent' && !agentId) {
      setError('Select an agent for agent-local files');
      return;
    }
    void doWrite(isEdit);
  };

  return {
    name, setName,
    source, setSource,
    agentId, setAgentId,
    content, setContent,
    originalContent,
    loading, error, isEdit, submit,
    hideSecrets, setHideSecrets,
  };
}
