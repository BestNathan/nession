import { toast } from 'sonner';
import type { EnvFileInfo, EnvFileRef, EnvSource } from '../../types';
import { envApi } from '@/features/env';
import { sourceLabel, toRef } from './envRef';
import { useAsyncOperation } from '../../hooks/useAsyncOperation';
import { useDataFetch } from '../../hooks/useDataFetch';

/** State + CRUD actions for the env management page. */
export function useEnvManager() {
  const listOp = useDataFetch(
    () => envApi.listEnvFiles().then((r) => r.files),
    [],
  );

  const deleteOp = useAsyncOperation(
    async (file: EnvFileInfo) => {
      if (!window.confirm(`Delete ${file.name} (${sourceLabel(file)})? This cannot be undone.`)) {
        return { success: false as const };
      }
      const resp = await envApi.deleteEnvFile(toRef(file));
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
    async (opts: { file: File; source: EnvSource; agentId?: string }) => {
      const { file, source, agentId } = opts;
      const content = await file.text();
      const name = file.name.endsWith('.env') ? file.name : `${file.name}.env`;
      const ref: EnvFileRef = { name, source, agent_id: agentId };
      let resp = await envApi.writeEnvFile(ref, content, false);
      if (!resp.success && resp.exists) {
        if (!window.confirm('File already exists. Overwrite?')) {
          return { success: false as const };
        }
        resp = await envApi.writeEnvFile(ref, content, true);
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
