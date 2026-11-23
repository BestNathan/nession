import { useCallback, useState } from 'react';
import type { Agent } from '@/types';
import type { Project } from '@/product/project/types';
import type { ProjectRuntimeMode } from '@/product/session/model/managedCreate';
import { useManagedCreateImages } from './useManagedCreateImages';

/**
 * The explicit Project runtime choice and its Managed EROFS selection (#3794).
 *
 * The dialog never derives a runtime silently: `native` and `managed` are two
 * user-visible choices, and every Managed field remains page state until the
 * reviewed Create. The Server/Agent stay the executable owners of every digest.
 */
export function useManagedCreateForm({
  isOpen,
  project,
  onlineAgents,
  onSelectionChange,
}: {
  isOpen: boolean;
  project?: Project | null;
  onlineAgents: Agent[];
  onSelectionChange: () => void;
}) {
  const [runtimeMode, setRuntimeModeState] = useState<ProjectRuntimeMode>('native');
  const [managedAgentId, setManagedAgentId] = useState('');
  const [baseDigest, setBaseDigestState] = useState('');
  const [toolchainDigests, setToolchainDigests] = useState<string[]>([]);
  const managedImages = useManagedCreateImages(
    isOpen && Boolean(project),
    project?.image_digest ?? undefined,
  );
  const managedAgent = onlineAgents.find((agent) => agent.agent_id === managedAgentId)
    ?? (managedAgentId
      ? undefined
      : onlineAgents.length > 0
        ? onlineAgents[0]
        : undefined);

  const resetManaged = useCallback(() => {
    setRuntimeModeState(
      project && project.locations.length === 0 && project.image_digest
        ? 'managed'
        : 'native',
    );
    setManagedAgentId(
      project?.locations
        .map((location) => location.agent_id)
        .find((id) => onlineAgents.some((agent) => agent.agent_id === id))
        ?? (onlineAgents.length > 0 ? onlineAgents[0].agent_id : ''),
    );
    setBaseDigestState('');
    setToolchainDigests([]);
  }, [onlineAgents, project]);

  const setRuntimeMode = (mode: ProjectRuntimeMode) => {
    setRuntimeModeState(mode);
    onSelectionChange();
  };
  const setManagedAgentIdAndNotify = (id: string) => {
    setManagedAgentId(id);
    onSelectionChange();
  };
  const setBaseDigest = (digest: string) => {
    setBaseDigestState(digest);
    onSelectionChange();
  };
  const toggleToolchain = (digest: string) => {
    setToolchainDigests((current) =>
      current.includes(digest)
        ? current.filter((candidate) => candidate !== digest)
        : [...current, digest],
    );
    onSelectionChange();
  };
  const moveToolchain = (digest: string, direction: -1 | 1) => {
    setToolchainDigests((current) => {
      const index = current.indexOf(digest);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    onSelectionChange();
  };

  return {
    runtimeMode,
    setRuntimeMode,
    managedAgentId,
    setManagedAgentId: setManagedAgentIdAndNotify,
    managedAgent,
    baseDigest,
    setBaseDigest,
    toolchainDigests,
    toggleToolchain,
    moveToolchain,
    managedImages,
    resetManaged,
  };
}
