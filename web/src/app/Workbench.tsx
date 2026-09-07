import { ReactNode } from 'react';

interface WorkbenchProps {
  /** Left sidebar content (agent list, session list, etc.) */
  sidebar: ReactNode;
  /** Main content area (terminal, dashboard, etc.) */
  children: ReactNode;
  /** Optional toolbar at the top */
  toolbar?: ReactNode;
}

/**
 * Workbench — the main application layout.
 *
 * Provides a consistent shell for the authenticated application state:
 * - Optional toolbar at the top
 * - Sidebar on the left (collapsible, responsive)
 * - Main content area on the right
 *
 * This is the app-layer composition root for the authenticated state.
 * All features render through Workbench, which handles layout and routing.
 */
export function Workbench({ sidebar, children, toolbar }: WorkbenchProps) {
  return (
    <div className="h-[100dvh] flex flex-col bg-background">
      {toolbar && (
        <div className="flex-shrink-0 border-b border-border">
          {toolbar}
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        <aside className="flex-shrink-0 border-r border-border overflow-y-auto">
          {sidebar}
        </aside>
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
