import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { agentDisplayName } from '@/shared/lib/format';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { Agent } from '@/types';
import type { ProjectDraft } from '@/product/project/types';

/** Existing Locations editor: zero or more `{agent_id, path}` declarations. */
export function ProjectLocationsEditor({
  draft,
  onChange,
  agents,
  disabled,
  idPrefix,
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  agents: Agent[];
  disabled: boolean;
  idPrefix: string;
}) {
  const setLocation = (index: number, patch: Partial<ProjectDraft['locations'][number]>) => {
    onChange({
      ...draft,
      locations: draft.locations.map((location, i) =>
        i === index ? { ...location, ...patch } : location,
      ),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Existing Locations (optional)</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="project-location-add"
          onClick={() =>
            onChange({
              ...draft,
              locations: [
                ...draft.locations,
                { agent_id: agents[0]?.agent_id ?? '', path: '' },
              ],
            })
          }
          disabled={disabled || agents.length === 0}
        >
          <Plus className="size-4" aria-hidden />
          Add Location
        </Button>
      </div>
      {agents.length === 0 ? (
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          No Agents are known yet. A Project can be created now and gain a location later.
        </p>
      ) : draft.locations.length === 0 ? (
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          No Existing Locations. A Project may exist without one.
        </p>
      ) : (
        draft.locations.map((location, index) => (
          <div key={index} className="flex items-end gap-2" data-testid="project-location-editor">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor={`${idPrefix}-location-agent-${index}`}>Agent</Label>
              <Select
                value={location.agent_id}
                onValueChange={(value) => value && setLocation(index, { agent_id: value })}
                disabled={disabled}
              >
                <SelectTrigger id={`${idPrefix}-location-agent-${index}`} className="w-full">
                  <span className="truncate">
                    {agentDisplayName(
                      agents.find((agent) => agent.agent_id === location.agent_id) ?? {
                        agent_id: location.agent_id,
                        hostname: location.agent_id,
                      } as Agent,
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.agent_id} value={agent.agent_id}>
                      {agentDisplayName(agent)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-[2] flex-col gap-2">
              <Label htmlFor={`${idPrefix}-location-path-${index}`}>Directory</Label>
              <Input
                id={`${idPrefix}-location-path-${index}`}
                value={location.path}
                onChange={(event) => setLocation(index, { path: event.target.value })}
                placeholder="/Users/you/code/project"
                disabled={disabled}
                autoComplete="off"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove Existing Location"
              data-testid={`project-location-remove-${index}`}
              onClick={() =>
                onChange({
                  ...draft,
                  locations: draft.locations.filter((_, i) => i !== index),
                })
              }
              disabled={disabled}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        ))
      )}
    </div>
  );
}
