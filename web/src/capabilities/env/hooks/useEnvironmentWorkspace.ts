import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  useSessionEnvBinding,
  type SessionEnvBinding,
} from '@/capabilities/env/hooks/useSessionEnvBinding';

export interface EnvironmentWorkspace {
  profiles: EnvironmentProfiles;
  /** The current Session's desired + observed Environment Binding. */
  binding: SessionEnvBinding;
  screen: EnvironmentScreen;
  /** `refKey`s in the desired selection — not proof of shell convergence. */
  includedKeys: ReadonlySet<string>;
  sessionId: string | null;
  /** The selected profile object, derived — robust across list refreshes. */
  selectedProfile: EnvFileInfo | null;
  importOpen: boolean;
  openImport: () => void;
  closeImport: () => void;
  /** Open the ordered binding draft from the live desired selection. */
  startBindingDraft: () => void;
  /** Commit one replace-whole-binding request; closes on a Server answer. */
  applyBinding: (refs: EnvFileRef[]) => Promise<boolean>;
  /** Re-resolve the desired profiles at a new revision. */
  reapplyBinding: () => Promise<boolean>;
  /** Return to the Session Environment view (Web link / App depth). */
  showSession: () => void;
  /**
   * One write attempt for the Edit depth. A successful attempt toasts,
   * refreshes the list and binding freshness, and closes Edit onto the saved
   * profile; a failed one is handed back for the editor's Replace/impact chain.
   */
  save: (input: EnvProfileSaveInput) => Promise<EnvWriteResponse>;
  /** Delete behind the detail's AlertDialog; failure toasts and keeps the profile. */
  deleteProfile: (profile: EnvFileInfo) => Promise<void>;
  /** Import success: refresh, then select the imported profile. */
  onImported: (ref: EnvFileRef) => void;
}

/**
 * The Environment Workspace composition (#1202, Session-first in #2654):
 * reusable profile list + the current Session binding + the shared screen
 * state machine + save/delete/import.
 *
 * The binding is the only owner of "which profiles this Session has"; the
 * profile list never marks a runtime state from a legacy apply/unset.
 */
export function useEnvironmentWorkspace(sessionId: string | null): EnvironmentWorkspace {
  const profiles = useEnvironmentProfiles();
  const binding = useSessionEnvBinding(sessionId);
  const screen = useEnvironmentScreen();
  const [importOpen, setImportOpen] = useState(false);

  // A Session switch abandons the old Session's selection and any edit/draft
  // in flight — they name that Session's context and must not reappear.
  const reset = screen.reset;
  useEffect(() => {
    reset();
  }, [reset, sessionId]);

  const selectedProfile =
    profiles.profiles.find((p) => refKey(p) === screen.selectedKey) ?? null;

  const includedKeys = useMemo(
    () =>
      new Set(
        (binding.binding?.desired_profiles ?? []).map((entry) =>
          refKey(entry.profile),
        ),
      ),
    [binding.binding],
  );

  const refreshBinding = binding.refresh;

  const startBindingDraft = useCallback(() => {
    const refs = (binding.binding?.desired_profiles ?? []).map(
      (entry) => entry.profile,
    );
    screen.startBindingDraft(refs);
  }, [binding.binding, screen]);

  const applyBinding = useCallback(
    async (refs: EnvFileRef[]): Promise<boolean> => {
      const resp = await binding.replace(refs);
      resp.warnings.forEach((warning) => toast.warning(warning));
      if (!resp.success) {
        toast.error(resp.error ?? 'Failed to update the Session binding');
      }
      if (resp.binding) {
        // The Server answered with the resulting desired state, even when the
        // Agent failed to materialize it. The draft is spent; the Session view
        // now shows the truthful outcome and offers Reapply.
        screen.finishBindingDraft();
      }
      return resp.success;
    },
    [binding, screen],
  );

  const reapplyBinding = useCallback(async (): Promise<boolean> => {
    const resp = await binding.reapply();
    resp.warnings.forEach((warning) => toast.warning(warning));
    if (!resp.success) {
      toast.error(resp.error ?? 'Failed to reapply the Session binding');
    }
    return resp.success;
  }, [binding]);

  const showSession = useCallback(() => {
    screen.showSession();
    void refreshBinding();
  }, [screen, refreshBinding]);

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
      await Promise.all([profiles.refresh(), refreshBinding()]);
      screen.finishEdit(refKey(input.ref));
      return resp;
    },
    [profiles, refreshBinding, screen],
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
      await Promise.all([profiles.refresh(), refreshBinding()]);
    },
    [profiles, refreshBinding, screen],
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
    binding,
    screen,
    includedKeys,
    sessionId,
    selectedProfile,
    importOpen,
    openImport: () => setImportOpen(true),
    closeImport: () => setImportOpen(false),
    startBindingDraft,
    applyBinding,
    reapplyBinding,
    showSession,
    save,
    deleteProfile,
    onImported,
  };
}
