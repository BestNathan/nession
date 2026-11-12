import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { persistConfirmedChoice } from '@/platform/attach/sessionAttachProfile';
import type { AttachChoice } from '@/product/session/components/AttachDialog';
import type { Session } from '@/types';

/** The Project destination is independent of the selected Session (#3025). */
export function useProjectSelection() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const selectProject = useCallback((projectId: string) => setSelectedProjectId(projectId), []);
  const closeProject = useCallback(() => setSelectedProjectId(null), []);
  return { selectedProjectId, selectProject, closeProject };
}

/** Settings Save: persist the profile only — never attach or reconnect. */
export function useAttachSettingsPersistence(cancelAttach: () => void) {
  return useCallback((session: Session, choice: AttachChoice) => {
    persistConfirmedChoice(session, choice, choice.attachInfo);
    cancelAttach();
    toast.success('Attach settings saved — applies to the next attach');
  }, [cancelAttach]);
}
