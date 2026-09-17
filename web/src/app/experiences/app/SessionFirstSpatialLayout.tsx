import {
  AppSpatialShell,
  type SpatialPageIndex,
} from './AppSpatialShell';
import { SessionFirstMain } from '@/app/SessionFirstMain';
import {
  SessionFirstSidebar,
  type SessionFirstSidebarProps,
} from '@/app/SessionFirstSidebar';
import type { DomainState } from '@/product/session/model/domainState';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/features/capabilities';
import type { FileOps } from '@/features/files';
import type { Agent, Session } from '@/types';

type SidebarFields = Omit<SessionFirstSidebarProps, 'className' | 'onSelect'>;

interface MainShared {
  selectedSession: Session | null;
  selectedAgent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  tool: CapabilityId;
  fileOps: FileOps | null;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: CapabilityId) => void;
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
        sessions={
          <SessionFirstSidebar {...sidebarProps} onSelect={onSpatialSelect} />
        }
        terminal={
          <div className="flex h-full min-h-0 flex-col">
            <SessionFirstMain
              {...mainShared}
              surface="terminal"
              showWorkspace={false}
              experience="app"
              onOpenDrawer={() => onIndexChange(0)}
              onOpenWorkspace={() => onIndexChange(2)}
            />
          </div>
        }
        workspace={
          <div className="flex h-full min-h-0 flex-col">
            <SessionFirstMain
              {...mainShared}
              surface="workspace"
              showTerminal={false}
              experience="app"
            />
          </div>
        }
      />
    </div>
  );
}
