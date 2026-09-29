import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { EnvFileInfo, EnvFileRef, EnvWriteResponse } from '@/types';
import { envApi } from '@/capabilities/env';
import { refKey, toRef } from '@/capabilities/env/model/envRef';
import {
  useEnvironmentProfiles,
  type EnvironmentProfiles,
} from '@/capabilities/env/hooks/useEnvironmentProfiles';
import {
  useEnvironmentScreen,
  type EnvironmentScreen,
} from '@/capabilities/env/hooks/useEnvironmentScreen';
import type { EnvProfileSaveInput } from '@/capabilities/env/hooks/useEnvProfileSave';

export interface EnvironmentWorkspace {
  profiles: EnvironmentProfiles;
  screen: EnvironmentScreen;
  /** The selected profile object, derived — robust across list refreshes. */
  selectedProfile: EnvFileInfo | null;
  importOpen: boolean;
  openImport: () => void;
  closeImport: () => void;
  /**
   * One write attempt for the Edit depth. A successful attempt toasts,
   * refreshes the list, and closes Edit onto the saved profile; a failed one
   * is handed back for the editor's Replace/impact chain.
   */
  save: (input: EnvProfileSaveInput) => Promise<EnvWriteResponse>;
  /** Delete behind the detail's AlertDialog; failure toasts and keeps the profile. */
  deleteProfile: (profile: EnvFileInfo) => Promise<void>;
  /** Import success: refresh, then select the imported profile. */
  onImported: (ref: EnvFileRef) => void;
}

/**
 * The Environment Workspace composition (#1202) shared by both experiences:
 * list + Session usage + the screen state machine + the save/delete/import
 * flows. The experiences own only how those pieces are laid out — a Web grid
 * and an App push — so the dirty-leave policy and the write chain each have
 * exactly one implementation.
 */
export function useEnvironmentWorkspace(sessionId: string | null): EnvironmentWorkspace {
  const profiles = useEnvironmentProfiles(sessionId);
  const screen = useEnvironmentScreen();
  const [importOpen, setImportOpen] = useState(false);

  // A Session switch abandons the old Session's selection and any edit in
  // flight — they name that Session's context and must not reappear.
  const reset = screen.reset;
  useEffect(() => {
    reset();
  }, [reset, sessionId]);

  const selectedProfile =
    profiles.profiles.find((p) => refKey(p) === screen.selectedKey) ?? null;

  const save = useCallback(
    async (input: EnvProfileSaveInput): Promise<EnvWriteResponse> => {
      const resp = await envApi.writeEnvFile(
        input.ref,
        input.content,
        input.overwrite,
        input.force,
      );
      if (!resp.success) {
        return resp;
      }
      toast.success(`Saved ${input.ref.name}`);
      resp.warnings?.forEach((w) => toast.warning(w));
      resp.re_source_errors?.forEach((e) => toast.warning(e));
      await profiles.refresh();
      screen.finishEdit(refKey(input.ref));
      return resp;
    },
    [profiles, screen],
  );

  const deleteProfile = useCallback(
    async (profile: EnvFileInfo): Promise<void> => {
      const resp = await envApi.deleteEnvFile(toRef(profile));
      if (!resp.success) {
        toast.error(resp.error ?? `Failed to delete ${profile.name}`);
        return;
      }
      toast.success(`Deleted ${profile.name}`);
      screen.finishEdit(null);
      await profiles.refresh();
    },
    [profiles, screen],
  );

  const onImported = useCallback(
    (ref: EnvFileRef) => {
      toast.success(`Imported ${ref.name}`);
      void profiles.refresh().then(() => {
        screen.finishEdit(refKey(ref));
      });
    },
    [profiles, screen],
  );

  return {
    profiles,
    screen,
    selectedProfile,
    importOpen,
    openImport: () => setImportOpen(true),
    closeImport: () => setImportOpen(false),
    save,
    deleteProfile,
    onImported,
  };
}
