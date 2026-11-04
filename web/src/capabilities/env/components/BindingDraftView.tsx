import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Search, X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Agent, EnvFileInfo, EnvFileRef } from '@/types';
import {
  useBindingPreview,
  type BindingPreview,
} from '@/capabilities/env/hooks/useBindingPreview';
import { refKey, toRef } from '@/capabilities/env/model/envRef';
import { profileLocation } from '@/capabilities/env/model/profile';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

export interface BindingDraftViewProps {
  /** The live desired selection at the time the draft opened. */
  baseline: EnvFileRef[];
  draft: EnvFileRef[];
  profiles: EnvFileInfo[];
  agents: Agent[];
  dirty: boolean;
  pending: boolean;
  error: string | null;
  onChange: (refs: EnvFileRef[]) => void;
  onCancel: () => void;
  onApply: (refs: EnvFileRef[]) => Promise<boolean>;
}

function displayName(ref: EnvFileRef, profiles: EnvFileInfo[]): string {
  return profiles.find((profile) => refKey(profile) === refKey(ref))?.name ?? ref.name;
}

function locationLabel(ref: EnvFileRef, profiles: EnvFileInfo[], agents: Agent[]): string {
  const profile = profiles.find((item) => refKey(item) === refKey(ref));
  return profile ? profileLocation(profile, agents) : 'Profile unavailable';
}

function BindingOrder({
  draft,
  profiles,
  agents,
  pending,
  onChange,
}: {
  draft: EnvFileRef[];
  profiles: EnvFileInfo[];
  agents: Agent[];
  pending: boolean;
  onChange: (refs: EnvFileRef[]) => void;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.length) {
      return;
    }
    const next = [...draft];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onChange(next);
  };

  if (draft.length === 0) {
    return (
      <p
        data-testid="env-draft-empty"
        className={cn('text-muted-foreground', chromeSansRole('secondary'))}
      >
        The Session will have no environment. Add a profile below.
      </p>
    );
  }

  return (
    <ol
      data-testid="env-draft-profiles"
      className="divide-y divide-border rounded-[var(--nession-radius-surface)] border"
    >
      {draft.map((ref, index) => (
        <li
          key={refKey(ref)}
          data-testid={`env-draft-profile-${refKey(ref)}`}
          className="flex items-center gap-2 px-2 py-1.5"
        >
          <span className={cn('w-5 shrink-0 text-muted-foreground', chromeSansRole('metadata'))}>
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn('block truncate', chromeSansRole('primary'))}
              title={ref.name}
            >
              {displayName(ref, profiles)}
            </span>
            <span className={cn('block truncate text-muted-foreground', chromeSansRole('metadata'))}>
              {locationLabel(ref, profiles, agents)}
            </span>
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Move ${ref.name} earlier`}
            data-testid={`env-draft-up-${refKey(ref)}`}
            disabled={index === 0 || pending}
            onClick={() => move(index, -1)}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Move ${ref.name} later`}
            data-testid={`env-draft-down-${refKey(ref)}`}
            disabled={index === draft.length - 1 || pending}
            onClick={() => move(index, 1)}
          >
            <ArrowDown className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${ref.name}`}
            data-testid={`env-draft-remove-${refKey(ref)}`}
            disabled={pending}
            onClick={() => onChange(draft.filter((_, i) => i !== index))}
          >
            <X className="size-3.5" />
          </Button>
        </li>
      ))}
    </ol>
  );
}

function ProfilePicker({
  profiles,
  agents,
  selectedKeys,
  pending,
  onAdd,
}: {
  profiles: EnvFileInfo[];
  agents: Agent[];
  selectedKeys: ReadonlySet<string>;
  pending: boolean;
  onAdd: (profile: EnvFileInfo) => void;
}) {
  const [query, setQuery] = useState('');
  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return profiles.filter((profile) => {
      if (selectedKeys.has(refKey(profile))) {
        return false;
      }
      return (
        !q ||
        profile.name.toLowerCase().includes(q) ||
        profileLocation(profile, agents).toLowerCase().includes(q)
      );
    });
  }, [profiles, selectedKeys, query, agents]);

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="env-draft-search"
          placeholder="Search profiles…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-8"
        />
      </div>
      <div className="mt-2 max-h-64 overflow-y-auto rounded-[var(--nession-radius-surface)] border">
        {available.length === 0 ? (
          <p className={cn('px-3 py-4 text-center text-muted-foreground', chromeSansRole('metadata'))}>
            {profiles.length === 0 ? 'No profiles are available.' : 'No more profiles match.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {available.map((profile) => (
              <li key={refKey(profile)} className="flex items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1">
                  <span
                    className={cn('block truncate', chromeSansRole('primary'))}
                    title={profile.name}
                  >
                    {profile.name}
                  </span>
                  <span className={cn('block truncate text-muted-foreground', chromeSansRole('metadata'))}>
                    {profileLocation(profile, agents)} · {profile.var_count} var
                    {profile.var_count === 1 ? '' : 's'}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`env-draft-add-${refKey(profile)}`}
                  disabled={pending}
                  onClick={() => onAdd(profile)}
                >
                  <Plus className="size-3.5" />
                  Add
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PreviewPanel({ preview }: { preview: BindingPreview }) {
  return (
    <div
      data-testid="env-draft-preview"
      className={cn('rounded-[var(--nession-radius-surface)] border px-3 py-2', chromeSansRole('metadata'))}
    >
      {preview.loading ? (
        <p className="text-muted-foreground">Calculating effective keys…</p>
      ) : preview.draft ? (
        <>
          <p>
            {preview.draft.keyCount} effective variable
            {preview.draft.keyCount === 1 ? '' : 's'} ·{' '}
            {preview.draft.overlaps.length === 0
              ? 'no overlapping keys'
              : `${preview.draft.overlaps.length} overlapping key${
                  preview.draft.overlaps.length === 1 ? '' : 's'
                }: ${preview.draft.overlaps.join(', ')}`}
          </p>
          <p className="mt-1 text-muted-foreground">
            {preview.changed.length === 0
              ? 'No effective value changes against the current binding.'
              : `Changed keys: ${preview.changed.join(', ')}`}
          </p>
          {preview.unavailable.length > 0 ? (
            <p data-testid="env-draft-unavailable" className="mt-1 text-warning">
              {preview.unavailable.length} profile
              {preview.unavailable.length === 1 ? '' : 's'} could not be read;
              the preview may be incomplete.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground">No preview is available.</p>
      )}
    </div>
  );
}

/**
 * The replace-whole binding draft (#2654).
 *
 * One ordered selection; later profiles win. Add, remove and keyboard/touch
 * reorder mutate only this draft. Apply sends the complete list in one request;
 * Cancel sends nothing. The preview shows effective-key counts, overlapping
 * key names and changed key names — never values.
 */
export function BindingDraftView({
  baseline,
  draft,
  profiles,
  agents,
  dirty,
  pending,
  error,
  onChange,
  onCancel,
  onApply,
}: BindingDraftViewProps) {
  const preview = useBindingPreview(baseline, draft, true);
  const selectedKeys = useMemo(() => new Set(draft.map(refKey)), [draft]);
  const add = (profile: EnvFileInfo) => {
    if (!selectedKeys.has(refKey(profile))) {
      onChange([...draft, toRef(profile)]);
    }
  };

  return (
    <div
      data-testid="env-binding-draft"
      className={cn(
        'flex h-full min-h-0 flex-col overflow-y-auto p-4',
        workspaceScrollClearanceClass,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            Session environment
          </p>
          <h2 className={cn(chromeSansRole('title'))}>Manage binding</h2>
          <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            The whole ordered selection is replaced in one revision. Later
            profiles win. Cancel changes nothing.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="env-draft-cancel"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="env-draft-apply"
            disabled={pending || !dirty}
            onClick={() => void onApply(draft)}
          >
            {pending ? 'Applying…' : 'Apply changes'}
          </Button>
        </div>
      </div>

      {error ? (
        <p
          data-testid="env-draft-error"
          className={cn('mt-3 rounded-[var(--nession-radius-surface)] bg-destructive/10 px-3 py-2 text-destructive', chromeSansRole('metadata'))}
        >
          {error}
        </p>
      ) : null}

      <section className="mt-5">
        <h3 className={cn('mb-2', chromeSansRole('primary'))}>
          Binding order <span className="text-muted-foreground">· later wins</span>
        </h3>
        <BindingOrder
          draft={draft}
          profiles={profiles}
          agents={agents}
          pending={pending}
          onChange={onChange}
        />
      </section>

      <section className="mt-5">
        <h3 className={cn('mb-2', chromeSansRole('primary'))}>Add a profile</h3>
        <ProfilePicker
          profiles={profiles}
          agents={agents}
          selectedKeys={selectedKeys}
          pending={pending}
          onAdd={add}
        />
      </section>

      <section className="mt-5">
        <h3 className={cn('mb-2', chromeSansRole('primary'))}>Change preview</h3>
        <PreviewPanel preview={preview} />
      </section>
    </div>
  );
}
