import { toast } from 'sonner';
import type { EnvFileInfo } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { sourceLabel, toRef } from './envRef';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useAsyncOperation } from '../../hooks/useAsyncOperation';
import { useDataFetch } from '../../hooks/useDataFetch';

/** State + CRUD actions for the env management page. */
export function useEnvManager(_wsService?: WebSocketService) {
  const wsService = useWebSocket(_wsService);

  const listOp = useDataFetch(
    () => wsService.listEnvFiles().then(r => r.files),
    [wsService],
  );

  const deleteOp = useAsyncOperation(
    async (file: EnvFileInfo) => {
      if (!window.confirm(`Delete ${file.name} (${sourceLabel(file)})? This cannot be undone.`)) {
        return { success: false as const };
      }
      const resp = await wsService.deleteEnvFile(toRef(file));
      if (resp.success) {
        toast.success(`Deleted ${file.name}`);
        void listOp.refetch();
      } else {
        toast.error(resp.error ?? 'Failed to delete');
      }
      return resp;
    },
    { showToastOnError: false },
  );

  const uploadOp = useAsyncOperation(
    async (file: File) => {
      const content = await file.text();
      const name = file.name.endsWith('.env') ? file.name : `${file.name}.env`;
      let resp = await wsService.writeEnvFile({ name, source: 'server' }, content, false);
      if (!resp.success && resp.exists) {
        if (!window.confirm('File already exists. Overwrite?')) {
          return { success: false as const };
        }
        resp = await wsService.writeEnvFile({ name, source: 'server' }, content, true);
      }
      if (resp.success) {
        toast.success(`Uploaded ${name}`);
        void listOp.refetch();
      } else if (!resp.exists) {
        toast.error(resp.error ?? 'Failed to upload');
      }
      return resp;
    },
    { showToastOnError: false },
  );

  return {
    files: listOp.data ?? [],
    loading: listOp.loading,
    refresh: listOp.refetch,
    deleteFile: deleteOp.execute,
    uploadFile: uploadOp.execute,
  };
}
