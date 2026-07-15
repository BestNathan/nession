import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type { EnvFileInfo } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { sourceLabel, toRef } from './envRef';
import { useWebSocket } from '../../hooks/useWebSocket';

/** State + CRUD actions for the env management page. */
export function useEnvManager(_wsService?: WebSocketService) {
  const wsService = useWebSocket(_wsService);
  const [files, setFiles] = useState<EnvFileInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await wsService.listEnvFiles();
      setFiles(resp.files);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to list env files');
    } finally {
      setLoading(false);
    }
  }, [wsService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const deleteFile = useCallback(
    async (file: EnvFileInfo) => {
      if (!window.confirm(`Delete ${file.name} (${sourceLabel(file)})? This cannot be undone.`)) {
        return;
      }
      try {
        const resp = await wsService.deleteEnvFile(toRef(file));
        if (resp.success) {
          toast.success(`Deleted ${file.name}`);
          void refresh();
        } else {
          toast.error(resp.error ?? 'Failed to delete');
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to delete');
      }
    },
    [wsService, refresh],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      const content = await file.text();
      const name = file.name.endsWith('.env') ? file.name : `${file.name}.env`;
      try {
        let resp = await wsService.writeEnvFile({ name, source: 'server' }, content, false);
        if (!resp.success && resp.exists) {
          if (!window.confirm('File already exists. Overwrite?')) {
            return;
          }
          resp = await wsService.writeEnvFile({ name, source: 'server' }, content, true);
        }
        if (resp.success) {
          toast.success(`Uploaded ${name}`);
          void refresh();
        } else if (!resp.exists) {
          toast.error(resp.error ?? 'Failed to upload');
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to upload');
      }
    },
    [wsService, refresh],
  );

  return { files, loading, refresh, deleteFile, uploadFile };
}
