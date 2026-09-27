import { useEffect } from 'react';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';

export function useAppFilesShellPush(
  depth: WorkspaceDepthControl,
  title: string | null,
  onLeave: () => void,
): void {
  const setPush = depth.setPush;
  useEffect(() => {
    setPush(title === null ? null : { title, onLeave });
  }, [setPush, title, onLeave]);
}
