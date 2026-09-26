import { Plus } from 'lucide-react';
import { resolveCapabilityPresences, type CapabilityId } from '@/product/capability';
import {
  CapabilityDisclosureMenu,
  type CapabilityDisclosureMenuEntry,
} from '@/product/capability/components/CapabilityDisclosureMenu';
import { cn } from '@/shared/lib/utils';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import {
  buildWorkspacePresentationModel,
  type WorkspacePresentationItem,
} from '@/app/workspace/presentation';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import type {
  WorkspaceContext,
  WorkspaceDepthControl,
  WorkspaceViewBinding,
} from '@/app/workspace/workspaceContext';

const workspaceViewBindings = new Map<string, WorkspaceViewBinding>(
  WORKSPACE_VIEW_BINDINGS.map((view) => [view.id, view]),
);

export interface WorkspaceShellProps {
  ctx: WorkspaceContext;
  activeCapabilityId: CapabilityId;
  /**
   * How the App half of a view declares the depth it is showing (#1051). The
   * App composes its views with one — its navigation bar is per depth — while
   * Web's pane has no depth to declare.
   *
   * Defaulted rather than required so a Web-only composition (the canonical
   * fixture) does not have to invent one. The App's composition always passes
   * its own, and an App view cannot render without it.
   */
  depth?: WorkspaceDepthControl;
  /**
   * Whether the open view has pushed a depth over its capability root. Gates
   * the dock, which belongs to the root — see `showDock` below.
   */
  pushed?: boolean;
}

/**
 * The depth control a composition with no navigation hierarchy passes.
 *
 * Nothing can usefully call it: a Web view has no App bar to declare a depth
 * to. It exists so the prop can be defaulted without making it possibly
 * `undefined` at the point an App view is rendered.
 */
const NO_DEPTH_CONTROL: WorkspaceDepthControl = { setPush: () => undefined };

function bindingFor(item: WorkspacePresentationItem): WorkspaceViewBinding | undefined {
  return workspaceViewBindings.get(item.snapshot.id);
}

function disclosureEntries(items: WorkspacePresentationItem[]): CapabilityDisclosureMenuEntry[] {
  return items.map((item) => {
    const binding = bindingFor(item)!;
    return {
      id: item.snapshot.id,
      title: item.snapshot.title,
      icon: binding.icon,
      state: item.snapshot.state,
    };
  });
}

/**
 * What the Workspace shows when the open capability has no view to draw.
 *
 * Both experiences answer "nothing" the same way, so the answer is named once
 * and reached from both halves of the branch below rather than written out on
 * each side of it.
 */
function UnavailableCapability({ title }: { title: string }) {
  return (
    <div
      data-testid="workspace-capability-unavailable"
      className="flex h-full min-h-0 items-center justify-center px-6 text-center"
    >
      <div className="max-w-sm space-y-1.5">
        <p className="text-sm font-medium text-foreground">{title} is not available here</p>
        <p className="text-xs text-muted-foreground">
          Choose another capability from More. Nession will keep this view stable instead of switching automatically.
        </p>
      </div>
    </div>
  );
}

/**
 * Workspace framework: semantic capabilities resolve first, then a bounded
 * Nession-owned presentation model decides what earns direct presence and what
 * stays progressively discoverable through More.
 */
export function WorkspaceShell({
  ctx,
  activeCapabilityId,
  depth = NO_DEPTH_CONTROL,
  pushed = false,
}: WorkspaceShellProps) {
  const resolution = resolveWorkspaceCapabilities(ctx);
  const presences = resolveCapabilityPresences(resolution.snapshots, {
    surface: 'workspace',
  });
  const presentation = buildWorkspacePresentationModel({
    snapshots: resolution.snapshots,
    presences,
    openedCapabilityId: activeCapabilityId,
  });

  const openedPresence = presentation.opened?.presence;
  const activeBinding = workspaceViewBindings.get(activeCapabilityId);
  const canRenderActive = activeBinding && openedPresence?.level !== 'hidden';
  // The two experiences' view props differ by construction (#1051): the App's
  // composition gives every view a depth control, Web's gives none. Branched
  // here rather than widened into one optional prop, so a Web view cannot be
  // handed the App's navigation and a new App view cannot silently go without it.
  const ActiveAppLayout = canRenderActive ? activeBinding.layout.app : null;
  const ActiveWebLayout = canRenderActive ? activeBinding.layout.web : null;
  // A view binding carries no name of its own — the capability does, so the
  // unavailable-state copy reads the same title the navigation shows.
  const activeTitle =
    resolution.snapshots.find((snapshot) => snapshot.id === activeCapabilityId)?.title ??
    activeCapabilityId;

  const directItems = [...presentation.primary, ...presentation.contextual].filter(bindingFor);
  const discoverableItems = presentation.discoverable.filter(bindingFor);
  const hasNavigation = directItems.length > 0 || discoverableItems.length > 0;
  // `#1051`: the dock is the *capability root's* switcher. A pushed detail has
  // its own page and its own Back, so a global capability switcher over it would
  // be a second navigation owner answering to a depth it does not belong to.
  const showDock = hasNavigation && !pushed;

  return (
    <div
      data-testid="workspace-shell"
      data-capability-diagnostics={resolution.diagnostics.length}
      /* The Workspace region's ground is the canvas, not a tint of it.
         The muted fill at 40% resolved to #F9F9F8 — a value that exists nowhere
         in the mockup, which draws the work region on its canvas (#FFFFFF) and
         separates the tree from the editor with the chrome surface (#F6F8FA) on
         the tree side only, which the Files layout already supplies. The domain
         `workspace.background` leaf is the canonical token for precisely this
         ground (domain.json -> `semantic.background`; file-workspace.md's token
         table names "Workspace/File surfaces -> Domain workspace.*"), and it was
         declared and consumed by nothing until here. */
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-workspace-background"
    >
      <div data-testid="workspace-tool-content" className="min-h-0 flex-1 overflow-hidden">
        {ctx.experience === 'app' ? (
          ActiveAppLayout ? (
            <ActiveAppLayout ctx={ctx} depth={depth} />
          ) : (
            <UnavailableCapability title={activeTitle} />
          )
        ) : ActiveWebLayout ? (
          <ActiveWebLayout ctx={ctx} />
        ) : (
          <UnavailableCapability title={activeTitle} />
        )}
      </div>

      {showDock ? (
        <div
          data-testid="workspace-tool-bar"
          data-navigation-mode="contextual"
          className="pointer-events-none absolute inset-x-0 bottom-[var(--shell-space-3)] z-10 flex justify-center px-4"
        >
          <nav
            aria-label="Workspace capabilities"
            className="pointer-events-auto flex items-center gap-1 rounded-full bg-background px-1.5 py-1.5 shadow-[var(--elevation-floating)]"
          >
            {directItems.map((item) => {
              const binding = bindingFor(item)!;
              const Icon = binding.icon;
              const isActive = item.snapshot.id === activeCapabilityId;
              return (
                <button
                  key={item.snapshot.id}
                  id={`workspace-capability-${item.snapshot.id}`}
                  type="button"
                  aria-pressed={isActive}
                  aria-label={item.snapshot.title}
                  title={item.snapshot.title}
                  data-testid={`workspace-tool-${item.snapshot.id}`}
                  data-capability-state={item.snapshot.state}
                  data-capability-presence={item.presence.level}
                  onClick={() => ctx.onToolChange(item.snapshot.id)}
                  className={cn(
                    'relative flex size-[length:var(--dock-target)] shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]',
                    isActive
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-[length:var(--icon-md)]" aria-hidden />
                  {/* The open capability is marked by a dot, not by filling the
                      target. It is always rendered so the row's geometry does
                      not shift between states. */}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute bottom-0.5 size-1 rounded-full',
                      isActive ? 'bg-foreground' : 'bg-transparent',
                    )}
                  />
                </button>
              );
            })}

            {discoverableItems.length > 0 ? (
              <CapabilityDisclosureMenu
                entries={disclosureEntries(discoverableItems)}
                onSelect={ctx.onToolChange}
                label="Workspace capabilities"
                testIdPrefix="workspace-capability-picker"
                trigger={
                  /* `+` is capability disclosure, never "create". Its name says
                     so in both the accessible name and the tooltip, and what it
                     opens is the same capability list the row's icons come from —
                     `entries` above is built from capability snapshots, so the
                     menu cannot become a resource picker without this line
                     changing too (#1051 criterion 7). */
                  <button
                    type="button"
                    aria-label="More workspace capabilities"
                    title="More workspace capabilities"
                    data-testid="workspace-capability-more"
                    className="flex size-[length:var(--dock-target)] shrink-0 items-center justify-center rounded-[var(--radius-md)] text-muted-foreground transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)] hover:text-foreground"
                  >
                    <Plus className="size-[length:var(--icon-md)]" aria-hidden />
                  </button>
                }
              />
            ) : null}
          </nav>
        </div>
      ) : null}
    </div>
  );
}
