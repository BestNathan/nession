import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Agent, EnvFileInfo } from '@/types';
import { refKey } from '@/capabilities/env/model/envRef';
import { profileLocation, profileMetaLine } from '@/capabilities/env/model/profile';

export interface EnvironmentNavigatorProps {
  profiles: EnvFileInfo[];
  agents: Agent[];
  /** Profiles sourced into the current Session, by `refKey`. */
  activeKeys: ReadonlySet<string>;
  /** Whether a current Session exists at all — gates the usage summary. */
  hasSession: boolean;
  loading: boolean;
  error: string | null;
  selectedKey: string | null;
  onSelect: (profile: EnvFileInfo) => void;
  onNew: () => void;
  onImport: () => void;
  onRetry: () => void;
  /**
   * App only (#1051): the pushed detail hides the list, so the list's scroll
   * position leaves with it — restore it when the detail pops. Same prop
   * names as `FileList`, which solves the same problem.
   */
  restoredScrollTop?: number;
  onScrollSnapshot?: (scrollTop: number) => void;
}

function EnvironmentRow({
  profile,
  agents,
  active,
  selected,
  onSelect,
}: {
  profile: EnvFileInfo;
  agents: Agent[];
  active: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`env-profile-row-${refKey(profile)}`}
      data-active={active || undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50',
        selected && 'bg-accent',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{profile.name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {profileMetaLine(profile, agents)}
        </span>
      </span>
      {active ? (
        <span className="shrink-0 text-xs text-muted-foreground">Active</span>
      ) : null}
    </button>
  );
}

function NavigatorBody(props: EnvironmentNavigatorProps & { query: string }) {
  const { profiles, agents, activeKeys, loading, error, selectedKey, query } = props;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return profiles;
    }
    return profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        profileLocation(p, agents).toLowerCase().includes(q),
    );
  }, [profiles, agents, query]);

  if (loading && profiles.length === 0) {
    return (
      <div className="flex flex-col gap-1 p-2" data-testid="env-navigator-loading">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  if (error && profiles.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div
        data-testid="env-navigator-empty"
        className="flex flex-col items-center gap-3 px-4 py-10 text-center"
      >
        <div className="space-y-1">
          <p className="text-sm font-medium">No environments yet</p>
          <p className="text-xs text-muted-foreground">
            Create or import an environment profile for this workspace.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={props.onNew}>
            New environment
          </Button>
          <Button size="sm" variant="outline" onClick={props.onImport}>
            Import .env
          </Button>
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
        No environments match &ldquo;{query.trim()}&rdquo;
      </p>
    );
  }

  return (
    <div className="divide-y divide-border" data-testid="env-profile-list">
      {filtered.map((p) => {
        const key = refKey(p);
        return (
          <EnvironmentRow
            key={key}
            profile={p}
            agents={agents}
            active={activeKeys.has(key)}
            selected={selectedKey === key}
            onSelect={() => props.onSelect(p)}
          />
        );
      })}
    </div>
  );
}

/**
 * The Environment navigator (#1202): search, one resource-creation `+`, the
 * current Session's usage as a quiet summary, and profile rows that lead with
 * the name. No inline delete, no file size, no badges — secondary actions
 * live in the Profile Detail.
 */
export function EnvironmentNavigator(props: EnvironmentNavigatorProps) {
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const activeNames = props.profiles
    .filter((p) => props.activeKeys.has(refKey(p)))
    .map((p) => p.name);

  useEffect(() => {
    if (props.restoredScrollTop === undefined || props.loading) {
      return;
    }
    const node = listRef.current;
    if (node) {
      node.scrollTop = props.restoredScrollTop;
    }
  }, [props.restoredScrollTop, props.loading]);

  return (
    <div data-testid="env-navigator" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="env-search"
            placeholder="Search profiles…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="New environment or import"
                data-testid="env-new-menu"
              />
            }
          >
            <Plus className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="env-new-profile" onClick={props.onNew}>
              New environment
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="env-import" onClick={props.onImport}>
              Import .env file
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {props.hasSession ? (
        <p
          data-testid="env-session-summary"
          className="border-b px-3 py-1.5 text-xs text-muted-foreground"
        >
          {activeNames.length > 0
            ? `Current Session · ${activeNames.join(', ')}`
            : 'Current Session · no environment applied'}
        </p>
      ) : null}

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="env-navigator-list"
        onScroll={() => {
          const node = listRef.current;
          if (node && props.onScrollSnapshot) {
            props.onScrollSnapshot(node.scrollTop);
          }
        }}
      >
        <NavigatorBody {...props} query={query} />
      </div>
    </div>
  );
}
