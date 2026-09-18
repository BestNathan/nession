import { Plus } from 'lucide-react';
import { resolveCapabilityPresences, type CapabilityId } from '@/product/capability';
import {
  CapabilityDisclosureMenu,
  type CapabilityDisclosureMenuEntry,
} from '@/product/capability/components/CapabilityDisclosureMenu';
import { cn } from '@/lib/utils';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import {
  buildWorkspacePresentationModel,
  type WorkspacePresentationItem,
} from '@/app/workspace/presentation';
import { WORKSPACE_VIEW_BINDINGS } from '@/app/workspace/viewBindings';
import type { WorkspaceContext, WorkspaceViewBinding } from '@/app/workspace/workspaceContext';

const workspaceViewBindings = new Map<string, WorkspaceViewBinding>(
  WORKSPACE_VIEW_BINDINGS.map((view) => [view.id, view]),
);

export interface WorkspaceShellProps {
  ctx: WorkspaceContext;
  activeCapabilityId: CapabilityId;
}

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
 * Workspace framework: semantic capabilities resolve first, then a bounded
 * Nession-owned presentation model decides what earns direct presence and what
 * stays progressively discoverable through More.
 */
export function WorkspaceShell({ ctx, activeCapabilityId }: WorkspaceShellProps) {
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
  const ActiveLayout = canRenderActive ? activeBinding.layout[ctx.experience] : null;
  // A view binding carries no name of its own — the capability does, so the
  // unavailable-state copy reads the same title the navigation shows.
  const activeTitle =
    resolution.snapshots.find((snapshot) => snapshot.id === activeCapabilityId)?.title ??
    activeCapabilityId;

  const directItems = [...presentation.primary, ...presentation.contextual].filter(bindingFor);
  const discoverableItems = presentation.discoverable.filter(bindingFor);
  const hasNavigation = directItems.length > 0 || discoverableItems.length > 0;

  return (
    <div
      data-testid="workspace-shell"
      data-capability-diagnostics={resolution.diagnostics.length}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40"
    >
      <div data-testid="workspace-tool-content" className="min-h-0 flex-1 overflow-hidden">
        {ActiveLayout ? (
          <ActiveLayout ctx={ctx} />
        ) : (
          <div
            data-testid="workspace-capability-unavailable"
            className="flex h-full min-h-0 items-center justify-center px-6 text-center"
          >
            <div className="max-w-sm space-y-1.5">
              <p className="text-sm font-medium text-foreground">
                {activeTitle} is not available here
              </p>
              <p className="text-xs text-muted-foreground">
                Choose another capability from More. Nession will keep this view stable instead of switching automatically.
              </p>
            </div>
          </div>
        )}
      </div>

      {hasNavigation ? (
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
