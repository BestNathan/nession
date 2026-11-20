import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The Workspace's Host-owned Bottom Actions slot (Issue 4115).
 *
 * The App host owns *where* a capability's bottom actions sit: above the
 * floating Capsule, with the measured safe-area/Capsule band as padding, and
 * below the page's scrollport so the scroll end and the actions cannot overlap.
 * A capability owns *what* the actions mean — Files' Copy/Delete, their
 * disabled/confirmation states — and contributes them as content. It must not
 * position a bottom band itself, because that is how the old Files action bar
 * ended up padded only by safe area while the floating Capsule covered it.
 *
 * The slot is a DOM node rendered by `WorkspaceShell`; this provider hands it
 * to capability content, and `WorkspaceBottomActions` portals the contributed
 * node into it. A portal rather than ReactNode state keeps the actions out of
 * the capability's scroll flow without making the host re-render on every
 * selection change.
 */
const WorkspaceActionsSlotContext = createContext<HTMLElement | null>(null);

export function WorkspaceActionsSlotProvider({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <WorkspaceActionsSlotContext.Provider value={slot}>
      {children}
    </WorkspaceActionsSlotContext.Provider>
  );
}

/**
 * Contributes content to the host's one bottom-actions role.
 *
 * Renders nothing when the host has no slot (Web, or a composition outside a
 * Workspace shell) or when the contribution is `null`.
 */
export function WorkspaceBottomActions({ children }: { children: ReactNode | null }) {
  const slot = useContext(WorkspaceActionsSlotContext);
  if (!slot || children === null) {
    return null;
  }
  return createPortal(children, slot);
}
