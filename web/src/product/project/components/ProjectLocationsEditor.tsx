import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { ChoiceItemContent } from '@/components/ui/choice-item';
import { FormRow, FormSection } from '@/components/ui/configuration-form';
import { agentDisplayName } from '@/shared/lib/format';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { Agent } from '@/types';
import type { ProjectDraft } from '@/product/project/types';

type Location = ProjectDraft['locations'][number];

function AgentField({
  location,
  index,
  agents,
  disabled,
  idPrefix,
  onChange,
}: {
  location: Location;
  index: number;
  agents: Agent[];
  disabled: boolean;
  idPrefix: string;
  onChange: (patch: Partial<Location>) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <Label htmlFor={`${idPrefix}-location-agent-${index}`}>Agent</Label>
      <Select
        value={location.agent_id}
        onValueChange={(value) => value && onChange({ agent_id: value })}
        disabled={disabled}
      >
        <SelectTrigger
          id={`${idPrefix}-location-agent-${index}`}
          size="field"
          className="w-full"
        >
          <span className="truncate">
            {agentDisplayName(
              agents.find((agent) => agent.agent_id === location.agent_id) ?? {
                agent_id: location.agent_id,
                hostname: location.agent_id,
              } as Agent,
            )}
          </span>
        </SelectTrigger>
        <SelectContent width="content">
          {agents.map((agent) => (
            <SelectItem key={agent.agent_id} value={agent.agent_id} anatomy="resource">
              <ChoiceItemContent
                title={agentDisplayName(agent)}
                meta={
                  agent.display_name && agent.display_name !== agent.hostname
                    ? agent.hostname
                    : undefined
                }
                status={
                  agent.status === 'online'
                    ? 'Online'
                    : agent.status === 'offline'
                      ? 'Offline'
                      : 'Degraded'
                }
                statusTone={agent.status === 'online' ? 'neutral' : 'unavailable'}
              />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PathField({
  location,
  index,
  disabled,
  idPrefix,
  onChange,
}: {
  location: Location;
  index: number;
  disabled: boolean;
  idPrefix: string;
  onChange: (patch: Partial<Location>) => void;
}) {
  return (
    <div className="flex min-w-0 flex-[2] flex-col gap-2">
      <Label htmlFor={`${idPrefix}-location-path-${index}`}>Directory</Label>
      <Textarea
        id={`${idPrefix}-location-path-${index}`}
        value={location.path}
        onChange={(event) => onChange({ path: event.target.value })}
        placeholder="/Users/you/code/project"
        disabled={disabled}
        autoComplete="off"
        rows={1}
        variant="field"
        className="break-all"
      />
    </div>
  );
}

function RemoveButton({
  index,
  disabled,
  stacked,
  onRemove,
}: {
  index: number;
  disabled: boolean;
  stacked: boolean;
  onRemove: () => void;
}) {
  if (stacked) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Remove Existing Location"
        data-testid={`project-location-remove-${index}`}
        onClick={onRemove}
        disabled={disabled}
        className="min-h-11"
      >
        <Trash2 className="size-4" aria-hidden />
        Remove
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2 self-start">
      {/* The action sits in the same label slot as the field labels, so it
          aligns with the control band rather than the bottom of a grown
          Directory field. */}
      <span aria-hidden className="hidden h-3.5 sm:block" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Remove Existing Location"
        data-testid={`project-location-remove-${index}`}
        onClick={onRemove}
        disabled={disabled}
        className="self-start"
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

function LocationRows({
  locations,
  agents,
  disabled,
  idPrefix,
  stacked,
  onChange,
  onRemove,
}: {
  locations: Location[];
  agents: Agent[];
  disabled: boolean;
  idPrefix: string;
  stacked: boolean;
  onChange: (index: number, patch: Partial<Location>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <>
      {locations.map((location, index) =>
        stacked ? (
          <FormRow
            key={index}
            className="gap-3"
            data-testid="project-location-editor"
          >
            <div className="flex items-center justify-between">
              <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                Location {index + 1}
              </span>
              <RemoveButton
                index={index}
                disabled={disabled}
                stacked
                onRemove={() => onRemove(index)}
              />
            </div>
            <AgentField
              location={location}
              index={index}
              agents={agents}
              disabled={disabled}
              idPrefix={idPrefix}
              onChange={(patch) => onChange(index, patch)}
            />
            <PathField
              location={location}
              index={index}
              disabled={disabled}
              idPrefix={idPrefix}
              onChange={(patch) => onChange(index, patch)}
            />
          </FormRow>
        ) : (
          <div
            key={index}
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start"
            data-testid="project-location-editor"
          >
            <AgentField
              location={location}
              index={index}
              agents={agents}
              disabled={disabled}
              idPrefix={idPrefix}
              onChange={(patch) => onChange(index, patch)}
            />
            <PathField
              location={location}
              index={index}
              disabled={disabled}
              idPrefix={idPrefix}
              onChange={(patch) => onChange(index, patch)}
            />
            <RemoveButton
              index={index}
              disabled={disabled}
              stacked={false}
              onRemove={() => onRemove(index)}
            />
          </div>
        ),
      )}
    </>
  );
}

/**
 * Existing Locations editor: zero or more `{agent_id, path}` declarations.
 *
 * `layout` names the composition, not the data: Web keeps an Agent/Directory
 * row that reflows to stacked controls when the dialog is constrained; App
 * always stacks, with touch-sized fields and a full-width Remove action
 * (#3089). Agent and Directory are top-aligned peers on the Experience control
 * band; Directory starts compact and grows downward with a wrapped path, so a
 * long value never drags the Agent field or the Remove action down (#3136). The
 * directory is still a textarea rather than a single-line input, because a long
 * path in a single-line control hides its own beginning.
 */
export function ProjectLocationsEditor({
  draft,
  onChange,
  agents,
  disabled,
  idPrefix,
  layout = 'responsive',
}: {
  draft: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  agents: Agent[];
  disabled: boolean;
  idPrefix: string;
  layout?: 'responsive' | 'stacked';
}) {
  const setLocation = (index: number, patch: Partial<Location>) => {
    onChange({
      ...draft,
      locations: draft.locations.map((location, i) =>
        i === index ? { ...location, ...patch } : location,
      ),
    });
  };

  const removeLocation = (index: number) => {
    onChange({
      ...draft,
      locations: draft.locations.filter((_, i) => i !== index),
    });
  };

  const stacked = layout === 'stacked';

  return (
    <FormSection
      title="Existing Locations"
      description="Optional. Agent directories this Project can start Sessions from."
      action={
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
          className={stacked ? 'min-h-11' : undefined}
        >
          <Plus className="size-4" aria-hidden />
          Add Location
        </Button>
      }
    >
      {agents.length === 0 ? (
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          No Agents are known yet. A Project can be created now and gain a location later.
        </p>
      ) : draft.locations.length === 0 ? (
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          No Existing Locations. A Project may exist without one.
        </p>
      ) : (
        <LocationRows
          locations={draft.locations}
          agents={agents}
          disabled={disabled}
          idPrefix={idPrefix}
          stacked={stacked}
          onChange={setLocation}
          onRemove={removeLocation}
        />
      )}
    </FormSection>
  );
}
