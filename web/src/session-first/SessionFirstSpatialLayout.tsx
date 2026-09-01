import {
  AppSpatialShell,
  type SpatialPageIndex,
} from '@/session-first/app-spatial/AppSpatialShell';
import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import {
  SessionFirstSidebar,
  type SessionFirstSidebarProps,
} from '@/session-first/SessionFirstSidebar';
import type { DomainState } from '@/session-first/domainState';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/session-first/workspace/toolTypes';
import type { FileOps } from '@/services/fileOps';
import type { Agent, Session } from '@/types';

type SidebarFields = Omit<SessionFirstSidebarProps, 'className' | 'onSelect'>;

interface MainShared {
  selectedSession: Session | null;
  selectedAgent: Agent | undefined;
  domain: DomainState | null;
  tool: WorkspaceToolId;
  fileOps: FileOps | null;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: WorkspaceToolId) => void;
  onOpenAgent: () => void;
}

export function SessionFirstSpatialLayout(props: {
  spatialIndex: SpatialPageIndex;
  onIndexChange: (index: SpatialPageIndex) => void;
  sidebarProps: SidebarFields;
  onSpatialSelect: (session: Session) => void;
  mainShared: MainShared;
}) {
  const { spatialIndex, onIndexChange, sidebarProps, onSpatialSelect, mainShared } =
    props;

  return (
    <div className="flex min-h-0 flex-1">
      <AppSpatialShell
        index={spatialIndex}
        onIndexChange={onIndexChange}
        showHeaderActions
        sessions={
          <SessionFirstSidebar {...sidebarProps} onSelect={onSpatialSelect} />
        }
        terminal={
          <div className="flex h-full min-h-0 flex-col">
            <SessionFirstMain
              {...mainShared}
              surface="terminal"
              showWorkspace={false}
            />
          </div>
        }
        workspace={
          <div className="flex h-full min-h-0 flex-col">
            <SessionFirstMain
              {...mainShared}
              surface="workspace"
              showTerminal={false}
            />
          </div>
        }
      />
    </div>
  );
}
