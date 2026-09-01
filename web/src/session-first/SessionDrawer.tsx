import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SessionDrawerProps {
  open: boolean;
  onClose: () => void;
  sidebar: ReactNode;
}

/** AI-style sessions drawer: left overlay with scrim, slides in over full-bleed content. */
export function SessionDrawer({ open, onClose, sidebar }: SessionDrawerProps) {
  if (!open) {
    return null;
  }
  return (
    <div className="absolute inset-0 z-40 lg:z-30" data-testid="session-drawer">
      <button
        type="button"
        aria-label="Close sessions"
        data-testid="session-drawer-scrim"
        onClick={onClose}
        className="absolute inset-0 bg-overlay/40"
      />
      <aside
        data-testid="session-drawer-panel"
        className={cn(
          'absolute inset-y-0 left-0 flex w-[min(20rem,90vw)] flex-col border-r border-border/60 bg-background shadow-xl',
          'animate-in slide-in-from-left duration-200',
        )}
      >
        {sidebar}
      </aside>
    </div>
  );
}
