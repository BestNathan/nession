import { AppLayers, type AppLayer } from './AppLayers';
import { ShellMain } from '@/app/ShellMain';
import type { MainProps } from '@/app/experiences/web/WebLayout';
import { Sidebar, type SidebarProps } from '@/app/Sidebar';
import type { DomainState } from '@/product/session/model/domainState';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import type { FileOps } from '@/capabilities/files';
import type { Agent, Session } from '@/types';

type SidebarFields = Omit<SidebarProps, 'className' | 'onSelect'>;

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

/**
 * The App experience's composition (#1049 stage 2).
 *
 * Replaces `SpatialLayout`. The difference that matters is what is mounted and
 * when: the Terminal is the root and is always present, while the Workspace
 * and Sessions layers exist only while they are open. Previously all three
 * pages were permanently mounted, which is why the App rendered two
 * `session-header-line` elements at all times and why the two headers could
 * disagree about which surface they described.
 *
 * `showWorkspace={false}` on the Terminal's `ShellMain` is still correct and
 * now means something slightly different: the Workspace is a sibling layer
 * that mounts its own `ShellMain`, so the root must not also render a
 * WorkspacePanel.
 */
export function AppLayout(props: {
  layer: AppLayer;
  onLayerChange: (layer: AppLayer) => void;
  sidebarProps: SidebarFields;
  onLayerSelect: (session: Session) => void;
  mainShared: MainShared;
  /**
   * Fixture/testing override for the terminal, same contract as
   * `WorkspaceRegion.terminal`. The canonical App fixtures pass the static
   * `FixtureTerminal` here so a baseline can be captured without a live attach.
   */
  terminal?: MainProps['terminal'];
}) {
  const {
    layer,
    onLayerChange,
    sidebarProps,
    onLayerSelect,
    mainShared,
    terminal,
  } = props;

  return (
    <div className="flex min-h-0 flex-1">
      <AppLayers
        layer={layer}
        onLayerChange={onLayerChange}
        sessions={
          <div className="flex h-full min-h-0 flex-col">
            <Sidebar {...sidebarProps} onSelect={onLayerSelect} />
          </div>
        }
        terminal={
          <div className="flex h-full min-h-0 flex-col">
            <ShellMain
              {...mainShared}
              surface="terminal"
              showWorkspace={false}
              experience="app"
              onOpenDrawer={() => onLayerChange('sessions')}
              onOpenWorkspace={() => onLayerChange('workspace')}
              terminal={terminal}
            />
          </div>
        }
        workspace={
          <div className="flex h-full min-h-0 flex-col">
            <ShellMain
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
