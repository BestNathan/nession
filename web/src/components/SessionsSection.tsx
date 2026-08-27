import { Plus } from 'lucide-react';
import type { Agent, Session } from '../types';
import { Button } from './ui/button';
import { RefreshButton } from './ui/RefreshButton';
import { SessionList } from './SessionList';
import type { SortField, SortDirection } from '../hooks/useDashboard';

export function SessionsSection({
  agents, filteredSessions, loadingSessions, staleAgents,
  onCreate, fetchSessions, onAttach, onKill, onPreview,
  sortField, sortDirection, toggleSort, isSearchActive,
}: {
  agents: Agent[];
  filteredSessions: Session[];
  loadingSessions: boolean;
  /** Agents whose data may be out of date after a failed force refresh. */
  staleAgents?: string[];
  onCreate: () => void;
  /** Triggers a force refresh — the server re-queries every online agent. */
  fetchSessions: (opts?: { force?: boolean }) => void;
  onAttach: (s: Session) => void;
  onKill: (s: Session) => void;
  onPreview: (s: Session) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (f: SortField) => void;
  isSearchActive: boolean;
}) {
  return (
    <section className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Sessions
        </h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onCreate}
            disabled={agents.every((a) => a.status !== 'online')}
            aria-label="Create session"
            className="min-h-9 min-w-9 md:min-h-7 md:min-w-0"
          >
            <Plus className="h-4 w-4 md:mr-1" />
            <span className="hidden md:inline">Create</span>
          </Button>
          <RefreshButton
            onClick={() => fetchSessions({ force: true })}
            loading={loadingSessions}
            variant="ghost"
            ariaLabel="Refresh sessions"
          />
        </div>
      </div>
      <SessionList
        sessions={filteredSessions}
        loading={loadingSessions}
        staleAgents={staleAgents}
        onAttach={onAttach}
        onKill={onKill}
        onPreview={onPreview}
        sortField={sortField}
        sortDirection={sortDirection}
        toggleSort={toggleSort}
        isSearchActive={isSearchActive}
      />
    </section>
  );
}
