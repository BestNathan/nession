import { AppLayers, type AppLayer } from './AppLayers';
import { AppSessionsSurface } from './AppSessionsSurface';
import { ShellMain } from '@/app/ShellMain';
import type { MainProps } from '@/app/experiences/web/WebLayout';
import type { SidebarProps } from '@/app/Sidebar';
import type { DomainState } from '@/product/session/model/domainState';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import type { FileOps } from '@/capabilities/files';
import type { Agent, Session } from '@/types';

/**
 * `collapsible` is dropped here rather than passed through as `false`: the App
 * surface has no rail, and `AppSessionsSurface` does not accept the prop at all
 * (#1050 Finding 1 — the App used to inherit its `true` default and could
 * collapse itself inside its own overlay).
 */
type SidebarFields = Omit<
  SidebarProps,
  'className' | 'onSelect' | 'collapsible'
>;

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
            <AppSessionsSurface {...sidebarProps} onSelect={onLayerSelect} />
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
          /* Opaque, deliberately (#1051). The layers are stacked at `inset-0`,
             so a transparent Workspace layer showed the Terminal's chrome and
             its scrollback through its own header band: the baseline drew two
             session titles superimposed and `$ git status --short` under the
             page header. Making the *layer* carry the Workspace's ground is what
             makes "one navigation bar owns this depth" true of the pixels and
             not only of the DOM — and it is what the Sessions layer already
             does, so the two sibling layers stop disagreeing about whether the
             Terminal is visible behind them.

             `workspace.background` and not the canvas directly: `domain.json`
             names this ground, and `WorkspaceShell` draws the work region on the
             same token, so the layer and the region it contains cannot drift. */
          <div className="flex h-full min-h-0 flex-col bg-workspace-background">
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
