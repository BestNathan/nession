import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { Agent, EnvFileInfo, EnvFileRef, EnvSource, EnvWriteResponse } from '../../types';
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

/** Surface save-result toasts (re-source, warnings, plain success) from a write response. */
function notifySaveResult(resp: EnvWriteResponse, isEdit: boolean): void {
  if (resp.re_sourced && resp.re_sourced.length > 0) {
    toast.success(`Re-sourced in ${resp.re_sourced.length} session(s)`);
  }
  if (resp.re_source_errors && resp.re_source_errors.length > 0) {
    resp.re_source_errors.forEach((e: string) => toast.error(`Re-source failed: ${e}`));
  }
  if (resp.warnings && resp.warnings.length > 0) {
    toast.warning(`Saved with warnings: ${resp.warnings.join('; ')}`);
  } else if (!resp.re_sourced || resp.re_sourced.length === 0) {
    toast.success(isEdit ? 'Env file updated' : 'Env file created');
  }
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
  const [inUseBy, setInUseBy] = useState<string[]>([]);

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
      setInUseBy([]);
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
            setInUseBy(resp.in_use_by ?? []);
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
      setInUseBy([]);
    }
  }, [isOpen, editing, cloneFrom, wsService]);

  const buildRef = (): EnvFileRef => {
    const fileName = name.trim().endsWith('.env') ? name.trim() : `${name.trim()}.env`;
    return { name: fileName, source, agent_id: source === 'agent' ? agentId : undefined };
  };

  const doWrite = async (overwrite: boolean, force = false): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const resp = await wsService.writeEnvFile(buildRef(), content, overwrite, force);
      if (resp.success) {
        notifySaveResult(resp, isEdit);
        onSaved();
        onClose();
      } else if (resp.exists) {
        if (window.confirm('File already exists. Overwrite?')) {
          await doWrite(true, force);
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
    void doWrite(isEdit, false);
  };

  return {
    name, setName,
    source, setSource,
    agentId, setAgentId,
    content, setContent,
    originalContent,
    loading, error, isEdit, submit,
    hideSecrets, setHideSecrets,
    inUseBy,
    doForceWrite: () => doWrite(true, true),
  };
}
