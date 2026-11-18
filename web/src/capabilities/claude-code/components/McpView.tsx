import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  FormField,
  FormGrid,
  FormSection,
  FormSurface,
} from '@/components/ui/configuration-form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  OperationActions,
  OperationError,
  OperationLead,
} from '@/components/ui/operation-surface';
import {
  DetailEmpty,
  DetailFact,
  DetailFacts,
  DetailHeader,
  DetailNote,
  DetailSection,
  DetailSurface,
} from '@/components/ui/resource-detail';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { formatSchema } from '../format';
import { serverApi } from '@/platform/server';
import type {
  ClaudeCodeMcpConnectState,
  ClaudeCodeMcpDefinition,
  ClaudeCodeMcpEntry,
  ClaudeCodeMcpHostingMode,
  ClaudeCodeMcpKeyValue,
  ClaudeCodeMcpPreflight,
  ClaudeCodeMcpProbe,
  ClaudeCodeMcpProbeStatus,
  ClaudeCodeMcpScope,
  ClaudeCodeMcpTool,
  ClaudeCodeMcpTransport,
  ClaudeCodeMcpWriteScope,
} from '../types';
import type { useMcp } from '../hooks/useMcp';

type McpState = ReturnType<typeof useMcp>;

const SCOPE_LABEL: Record<ClaudeCodeMcpScope, string> = {
  local: 'Local',
  project: 'Project',
  user: 'User',
  managed: 'Managed',
  plugin: 'Plugin',
};

const TRANSPORT_LABEL: Record<ClaudeCodeMcpTransport, string> = {
  stdio: 'stdio',
  http: 'HTTP',
  sse: 'SSE',
  ws: 'WebSocket',
  unknown: 'Unknown',
};

const APPROVAL_LABEL: Record<ClaudeCodeMcpEntry['approval'], string> = {
  approved: 'approved',
  pending: 'pending',
  rejected: 'rejected',
  not_required: 'not required',
  unknown: 'unknown',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed';
}

function transportOf(value: ClaudeCodeMcpTransport): ClaudeCodeMcpTransport {
  return value;
}

function entryKey(entry: Pick<ClaudeCodeMcpEntry, 'name' | 'scope'>): string {
  return `${entry.scope}:${entry.name}`;
}

function entryTone(entry: ClaudeCodeMcpEntry): 'secondary' | 'outline' | 'destructive' {
  if (entry.blocked) {
    return 'destructive';
  }
  return entry.effective ? 'secondary' : 'outline';
}

function entryStateLabel(entry: ClaudeCodeMcpEntry): string {
  if (entry.blocked === 'enterprise_exclusive') {
    return 'Blocked by managed policy';
  }
  if (entry.blocked) {
    return entry.blocked.split('_').join(' ');
  }
  if (entry.shadowed_by) {
    return `Shadowed by ${SCOPE_LABEL[entry.shadowed_by].toLowerCase()}`;
  }
  if (entry.approval === 'pending') {
    return 'Pending approval';
  }
  if (entry.approval === 'rejected') {
    return 'Rejected in settings';
  }
  if (entry.approval === 'unknown') {
    return 'Approval unknown';
  }
  return entry.effective ? 'Effective' : 'Configured';
}

function parseEnv(text: string): ClaudeCodeMcpKeyValue[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator < 0) {
        return { name: line, value: null };
      }
      return {
        name: line.slice(0, separator).trim(),
        value: line.slice(separator + 1),
      };
    });
}

function parseHeaders(text: string): ClaudeCodeMcpKeyValue[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':');
      if (separator < 0) {
        return { name: line, value: null };
      }
      return {
        name: line.slice(0, separator).trim(),
        value: line.slice(separator + 1).trimStart(),
      };
    });
}

function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function probeLabel(status: ClaudeCodeMcpProbeStatus): string {
  switch (status) {
    case 'not_requested':
      return 'Not inspected';
    case 'ok':
      return 'Discovery completed';
    case 'truncated':
      return 'Discovery completed; list truncated';
    case 'unsupported':
      return 'Discovery unsupported';
    case 'refused':
      return 'Discovery refused';
    case 'failed':
      return 'Discovery failed';
  }
}

function ProbeSection({
  probe,
  onOpenTool,
}: {
  probe: ClaudeCodeMcpProbe;
  /**
   * App: a tool's schema is its own pushed depth, so the row reports the
   * choice instead of unfolding a desktop disclosure inside the server page.
   * Web omits it and keeps the inline `<details>`.
   */
  onOpenTool?: (tool: ClaudeCodeMcpTool) => void;
}) {
  return (
    <DetailSection title="Tools and capabilities" testId="claude-code-mcp-probe">
      <DetailFacts>
        <DetailFact label="Probe" inline>
          {probeLabel(probe.status)}
          {probe.source ? ` · via ${probe.source}` : ''}
        </DetailFact>
        {probe.capabilities.length > 0 ? (
          <DetailFact label="Advertised" inline>
            {probe.capabilities.join(', ')}
          </DetailFact>
        ) : null}
      </DetailFacts>
      {probe.status === 'not_requested' ? (
        <DetailEmpty>
          Selecting Inspect tools opens a bounded discovery connection. Opening this
          view never contacts the server.
        </DetailEmpty>
      ) : null}
      {probe.status === 'failed' ||
      probe.status === 'refused' ||
      probe.status === 'unsupported' ? (
        <DetailNote>{probe.error ?? 'The server did not answer a discovery request.'}</DetailNote>
      ) : null}
      {probe.tools.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="claude-code-mcp-tools">
          {probe.tools.map((tool) =>
            onOpenTool ? (
              <button
                key={tool.name}
                type="button"
                className={cn(
                  'flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-[var(--nession-radius-control)] px-2 py-1.5 text-left transition-colors',
                  'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
                )}
                onClick={() => onOpenTool(tool)}
                data-testid="claude-code-mcp-tool-open"
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className={cn('min-w-0 truncate', chromeSansRole('secondary'))}>
                    {tool.name}
                  </span>
                  {tool.description ? (
                    <span className={cn('min-w-0 truncate text-muted-foreground', chromeSansRole('caption'))}>
                      {tool.description}
                    </span>
                  ) : null}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            ) : (
              <div key={tool.name} className="flex min-w-0 flex-col gap-1">
                <p className={cn('min-w-0', chromeSansRole('secondary'))}>{tool.name}</p>
                {tool.description ? (
                  <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                    {tool.description}
                  </p>
                ) : null}
                {tool.input_schema ? (
                  <details>
                    <summary className={cn('cursor-pointer text-muted-foreground', chromeSansRole('caption'))}>
                      Input schema
                    </summary>
                    <pre
                      className={cn(
                        'mt-1 max-h-48 overflow-auto rounded-[var(--nession-radius-control)] bg-muted p-2',
                        chromeMonoRole('code'),
                      )}
                    >
                      {formatSchema(tool.input_schema)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ),
          )}
        </div>
      ) : null}
      {probe.status === 'ok' || probe.status === 'truncated' ? (
        probe.tools.length === 0 &&
        probe.resources.length === 0 &&
        probe.prompts.length === 0 ? (
          <DetailEmpty>The server answered, but advertises no Tools, Resources or Prompts.</DetailEmpty>
        ) : null
      ) : null}
      {probe.resources.length > 0 ? (
        <DetailFacts>
          {probe.resources.map((resource) => (
            <DetailFact key={resource.uri} label={resource.name ?? 'Resource'} mono>
              {resource.uri}
            </DetailFact>
          ))}
        </DetailFacts>
      ) : null}
      {probe.prompts.length > 0 ? (
        <DetailFacts>
          {probe.prompts.map((prompt) => (
            <DetailFact key={prompt.name} label="Prompt" inline>
              {prompt.name}
            </DetailFact>
          ))}
        </DetailFacts>
      ) : null}
      {probe.status === 'ok' || probe.status === 'truncated' ? (
        <DetailNote>
          This is what the endpoint answered from this Agent. It does not mean the
          running Claude session has loaded these Tools.
        </DetailNote>
      ) : null}
    </DetailSection>
  );
}

function ServerRow({
  entry,
  selected,
  onSelect,
  touch,
}: {
  entry: ClaudeCodeMcpEntry;
  selected: boolean;
  onSelect: () => void;
  touch: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={`claude-code-mcp-row-${entry.scope}-${entry.name}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 rounded-[var(--nession-radius-control)] px-2 py-1.5 text-left transition-colors',
        touch && 'min-h-11',
        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
        selected && 'bg-accent text-accent-foreground',
      )}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className={cn('truncate', chromeSansRole('secondary'))}>{entry.name}</span>
        <Badge variant={entryTone(entry)}>{SCOPE_LABEL[entry.scope]}</Badge>
      </span>
      <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
        {TRANSPORT_LABEL[entry.transport]} · {entryStateLabel(entry)}
      </span>
    </button>
  );
}

function SourceList({ mcp }: { mcp: McpState }) {
  const sources = mcp.inventory?.sources ?? [];
  const notable = sources.filter((source) => source.state !== 'read' && source.state !== 'missing');
  if (notable.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1 px-2 py-2" data-testid="claude-code-mcp-sources">
      {notable.map((source) => (
        <p key={source.id} className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          {source.id}: {source.state}
          {source.detail ? ` — ${source.detail}` : ''}
        </p>
      ))}
    </div>
  );
}

function ServerList({
  mcp,
  onAdd,
  onSelect,
  touch,
}: {
  mcp: McpState;
  onAdd: () => void;
  onSelect: (entry: ClaudeCodeMcpEntry) => void;
  touch: boolean;
}) {
  const servers = mcp.inventory?.servers ?? [];
  const effective = servers.filter((entry) => entry.effective).length;
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          {servers.length} configured · {effective} effective
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="claude-code-mcp-add"
            onClick={onAdd}
          >
            <Plus className="size-3.5" /> Add server
          </Button>
        </div>
      </div>
      <div className={cn('min-h-0 flex-1 overflow-y-auto p-1', workspaceScrollClearanceClass)}>
        {servers.length === 0 ? (
          <div className="p-3">
            <DetailEmpty>
              No MCP servers are configured for this Session's Claude user.
            </DetailEmpty>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {servers.map((entry) => (
              <ServerRow
                key={entryKey(entry)}
                entry={entry}
                selected={
                  mcp.selection?.name === entry.name && mcp.selection.scope === entry.scope
                }
                onSelect={() => onSelect(entry)}
                touch={touch}
              />
            ))}
          </div>
        )}
        <SourceList mcp={mcp} />
      </div>
    </div>
  );
}

function EntryActions({
  busy,
  canEdit,
  name,
  onInspect,
  onEdit,
  onRemove,
}: {
  busy: boolean;
  canEdit: boolean;
  name: string;
  onInspect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="claude-code-mcp-inspect"
        onClick={onInspect}
        disabled={busy}
      >
        <Wrench className="size-3.5" /> Inspect tools
      </Button>
      {canEdit ? (
        <>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Edit ${name}`}
            onClick={onEdit}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      ) : null}
    </>
  );
}

function EntryFacts({ entry }: { entry: ClaudeCodeMcpEntry }) {
  return (
    <DetailFacts>
      {entry.url ? (
        <DetailFact label="URL" mono>
          {entry.url}
        </DetailFact>
      ) : null}
      {entry.command ? (
        <DetailFact label="Command" mono>
          {entry.command}
        </DetailFact>
      ) : null}
      {entry.argument_count > 0 ? (
        <DetailFact label="Arguments" mono>
          {entry.sanitized_args.length > 0
            ? entry.sanitized_args.join(' ')
            : `${entry.argument_count} argument(s)`}
        </DetailFact>
      ) : null}
      {entry.env_names.length > 0 ? (
        <DetailFact label="Environment" inline>
          {entry.env_names.join(', ')}
        </DetailFact>
      ) : null}
      {entry.header_names.length > 0 ? (
        <DetailFact label="Headers" inline>
          {entry.header_names.join(', ')}
        </DetailFact>
      ) : null}
      <DetailFact label="Approval" inline>
        {APPROVAL_LABEL[entry.approval]}
      </DetailFact>
      <DetailFact label="Loaded in Claude" inline>
        unknown — configuration does not prove a running session loaded it
      </DetailFact>
      {entry.conflict ? (
        <DetailFact label="Conflict" inline>
          Another scope defines this name with a different endpoint or command
        </DetailFact>
      ) : null}
    </DetailFacts>
  );
}

function ServerDetail({
  mcp,
  entry,
  isApp,
  showBack,
  onOpenTool,
  onEdit,
  onRemove,
  onInspect,
  onBack,
}: {
  mcp: McpState;
  entry: ClaudeCodeMcpEntry;
  isApp: boolean;
  /** Whether the inline App Back is this surface's leave. */
  showBack: boolean;
  onOpenTool?: (tool: ClaudeCodeMcpTool) => void;
  onEdit: () => void;
  onRemove: () => void;
  onInspect: () => void;
  onBack: () => void;
}) {
  const canEdit = !entry.read_only && (entry.scope === 'local' || entry.scope === 'project');
  return (
    <div
      data-testid="claude-code-mcp-detail"
      className={cn('min-h-0 flex-1 overflow-y-auto p-4', workspaceScrollClearanceClass)}
    >
      {isApp && showBack ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mb-2"
          data-testid="claude-code-mcp-back"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" /> MCP servers
        </Button>
      ) : null}
      <DetailSurface>
        <DetailHeader
          eyebrow="Claude MCP server"
          title={entry.name}
          badges={
            <>
              <Badge variant={entryTone(entry)}>{SCOPE_LABEL[entry.scope]}</Badge>
              {entry.effective ? <Badge variant="outline">Effective</Badge> : null}
              {entry.blocked ? <Badge variant="destructive">Blocked</Badge> : null}
            </>
          }
          meta={`${TRANSPORT_LABEL[entry.transport]} · ${entry.source}`}
          description={entryStateLabel(entry)}
          actions={
            <EntryActions
              busy={mcp.detailLoading}
              canEdit={canEdit}
              name={entry.name}
              onInspect={onInspect}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          }
        />
        {mcp.detailError ? <DetailNote>{mcp.detailError}</DetailNote> : null}
        <DetailSection title="Configuration">
          <EntryFacts entry={entry} />
          {entry.read_only ? (
            <DetailNote>
              {entry.scope === 'user'
                ? 'User scope is read-only here; the global AI resource manager owns its mutation.'
                : 'This source is read-only. Claude or an administrator owns the mutation.'}
            </DetailNote>
          ) : null}
        </DetailSection>
        {mcp.probe ? <ProbeSection probe={mcp.probe} onOpenTool={onOpenTool} /> : null}
      </DetailSurface>
    </div>
  );
}

type EditorState = {
  mode: 'add' | 'edit';
  scope: ClaudeCodeMcpWriteScope;
  name: string;
  transport: ClaudeCodeMcpTransport;
  url: string;
  command: string;
  argsText: string;
  envText: string;
  headersText: string;
  replaceArgs: boolean;
  replaceEnv: boolean;
  replaceHeaders: boolean;
  projectConfirmed: boolean;
  replaceExisting: boolean;
};

function editorForAdd(): EditorState {
  return {
    mode: 'add',
    scope: 'local',
    name: '',
    transport: 'http',
    url: '',
    command: '',
    argsText: '',
    envText: '',
    headersText: '',
    replaceArgs: false,
    replaceEnv: false,
    replaceHeaders: false,
    projectConfirmed: false,
    replaceExisting: false,
  };
}

function editorForEntry(entry: ClaudeCodeMcpEntry): EditorState {
  return {
    mode: 'edit',
    scope: entry.scope === 'project' ? 'project' : 'local',
    name: entry.name,
    transport: entry.transport === 'unknown' ? 'http' : entry.transport,
    url: '',
    command: entry.command ?? '',
    argsText: '',
    envText: '',
    headersText: '',
    replaceArgs: false,
    replaceEnv: false,
    replaceHeaders: false,
    projectConfirmed: false,
    replaceExisting: false,
  };
}

function IdentitySection({
  editor,
  editing,
  onChange,
}: {
  editor: EditorState;
  editing: boolean;
  onChange: (update: Partial<EditorState>) => void;
}) {
  return (
    <FormSection title="Identity">
      <FormGrid>
        <FormField id="mcp-name" label="Name">
          <Input
            id="mcp-name"
            value={editor.name}
            disabled={editing}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="github"
          />
        </FormField>
        <FormField id="mcp-transport" label="Transport">
          <Select
            value={editor.transport}
            onValueChange={(value) =>
              value && onChange({ transport: transportOf(value as ClaudeCodeMcpTransport) })
            }
          >
            <SelectTrigger id="mcp-transport" className="w-full" size="field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">HTTP</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="ws">WebSocket</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </FormGrid>
      <FormGrid>
        <FormField id="mcp-scope" label="Scope">
          <Select
            value={editor.scope}
            onValueChange={(value) =>
              value && onChange({ scope: value as ClaudeCodeMcpWriteScope })
            }
            disabled={editing}
          >
            <SelectTrigger id="mcp-scope" className="w-full" size="field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local — private to this project</SelectItem>
              <SelectItem value="project">Project — shared .mcp.json</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        {editor.scope === 'project' ? (
          <FormField label="Shared file">
            <label className="flex min-h-8 items-start gap-2">
              <input
                type="checkbox"
                checked={editor.projectConfirmed}
                onChange={(event) => onChange({ projectConfirmed: event.target.checked })}
              />
              <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                I understand `.mcp.json` may be committed and shared.
              </span>
            </label>
          </FormField>
        ) : null}
      </FormGrid>
    </FormSection>
  );
}

function ConnectionSection({
  editor,
  editing,
  currentUrl,
  currentArgCount,
  onChange,
}: {
  editor: EditorState;
  editing: boolean;
  currentUrl?: string;
  currentArgCount: number;
  onChange: (update: Partial<EditorState>) => void;
}) {
  if (editor.transport !== 'stdio') {
    return (
      <FormSection title="Connection">
        <FormField
          id="mcp-url"
          label="URL"
          description={
            editing && currentUrl
              ? `Current: ${currentUrl}. Leave blank to keep it.`
              : 'The endpoint URL.'
          }
        >
          <Input
            id="mcp-url"
            value={editor.url}
            onChange={(event) => onChange({ url: event.target.value })}
            placeholder={
              editor.transport === 'ws'
                ? 'wss://example.invalid/mcp'
                : 'https://example.invalid/mcp'
            }
          />
        </FormField>
      </FormSection>
    );
  }
  return (
    <FormSection title="Connection">
      <FormField
        id="mcp-command"
        label="Command"
        description="The executable Claude starts. Arguments are separate lines."
      >
        <Input
          id="mcp-command"
          value={editor.command}
          onChange={(event) => onChange({ command: event.target.value })}
          placeholder={editing ? 'Leave blank to keep the current command' : 'npx'}
        />
      </FormField>
      <FormField label="Arguments">
        <Textarea
          value={editor.argsText}
          onChange={(event) => onChange({ argsText: event.target.value })}
          placeholder={
            editing
              ? `Leave blank to keep the ${currentArgCount} existing argument(s)`
              : 'One argument per line'
          }
        />
      </FormField>
      {editing ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={editor.replaceArgs}
            onChange={(event) => onChange({ replaceArgs: event.target.checked })}
          />
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Replace the existing arguments
          </span>
        </label>
      ) : null}
    </FormSection>
  );
}

function PairCheckbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>{label}</span>
    </label>
  );
}

function PairsSection({
  editor,
  envNames,
  headerNames,
  onChange,
}: {
  editor: EditorState;
  envNames: string[];
  headerNames: string[];
  onChange: (update: Partial<EditorState>) => void;
}) {
  return (
    <FormSection
      title="Environment and headers"
      description="Values are written to Claude's configuration. Existing values are never shown."
    >
      <FormField
        label="Environment"
        description={`One KEY=value per line${envNames.length > 0 ? `. Existing: ${envNames.join(', ')}` : ''}`}
      >
        <Textarea
          value={editor.envText}
          onChange={(event) => onChange({ envText: event.target.value })}
          placeholder="API_KEY=${API_KEY}"
        />
      </FormField>
      <FormField
        label="Headers"
        description={`One Name: value per line${headerNames.length > 0 ? `. Existing: ${headerNames.join(', ')}` : ''}`}
      >
        <Textarea
          value={editor.headersText}
          onChange={(event) => onChange({ headersText: event.target.value })}
          placeholder="Authorization: Bearer ${TOKEN}"
        />
      </FormField>
      <div className="flex flex-col gap-1">
        <PairCheckbox
          checked={editor.replaceEnv}
          label="Replace all environment variables"
          onChange={(checked) => onChange({ replaceEnv: checked })}
        />
        <PairCheckbox
          checked={editor.replaceHeaders}
          label="Replace all headers"
          onChange={(checked) => onChange({ replaceHeaders: checked })}
        />
        <PairCheckbox
          checked={editor.replaceExisting}
          label="Resolve a same-name conflict in another scope"
          onChange={(checked) => onChange({ replaceExisting: checked })}
        />
      </div>
    </FormSection>
  );
}

function EntryEditor({
  editor,
  isApp,
  busy,
  error,
  currentUrl,
  currentArgCount,
  envNames,
  headerNames,
  onChange,
  onCancel,
  onSave,
}: {
  editor: EditorState;
  isApp: boolean;
  busy: boolean;
  error: string | null;
  currentUrl?: string;
  currentArgCount: number;
  envNames: string[];
  headerNames: string[];
  onChange: (update: Partial<EditorState>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const editing = editor.mode === 'edit';
  return (
    <Dialog open onOpenChange={(open) => open || onCancel()}>
      <DialogContent
        size="standard"
        variant={isApp ? 'fullscreen' : 'centered'}
        data-testid="claude-code-mcp-form"
        data-experience={isApp ? 'app' : undefined}
      >
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit MCP server' : 'Add MCP server'}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 overflow-y-auto">
          <OperationLead>
            {editing
              ? 'Only this scope is changed; other scopes and unrelated entries are preserved. Secret values are never read back — leave a value blank to keep it.'
              : 'The entry is written through the Claude CLI. Project scope writes a shared .mcp.json.'}
          </OperationLead>
          {error ? <OperationError testId="claude-code-mcp-form-error">{error}</OperationError> : null}
          <FormSurface>
            <IdentitySection editor={editor} editing={editing} onChange={onChange} />
            <ConnectionSection
              editor={editor}
              editing={editing}
              currentUrl={currentUrl}
              currentArgCount={currentArgCount}
              onChange={onChange}
            />
            <PairsSection
              editor={editor}
              envNames={envNames}
              headerNames={headerNames}
              onChange={onChange}
            />
          </FormSurface>
        </DialogBody>
        <DialogFooter>
          <OperationActions className="w-full justify-end">
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={onSave} disabled={busy} data-testid="claude-code-mcp-save">
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </OperationActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  entry,
  isApp,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  entry: ClaudeCodeMcpEntry;
  isApp: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (confirmedProject: boolean) => void;
}) {
  const [confirmedProject, setConfirmedProject] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => open || onCancel()}>
      <DialogContent
        size="standard"
        variant={isApp ? 'fullscreen' : 'centered'}
        data-testid="claude-code-mcp-remove"
        data-experience={isApp ? 'app' : undefined}
      >
        <DialogHeader>
          <DialogTitle>Remove {entry.name}?</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <OperationLead>
            This removes the {SCOPE_LABEL[entry.scope].toLowerCase()}-scope definition
            through Claude's CLI. It does not stop a server a running session already
            connected to, and it cannot be undone from here.
          </OperationLead>
          {entry.scope === 'project' ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmedProject}
                onChange={(event) => setConfirmedProject(event.target.checked)}
              />
              <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                I understand this edits the shared project `.mcp.json`.
              </span>
            </label>
          ) : null}
          {error ? <OperationError testId="claude-code-mcp-remove-error">{error}</OperationError> : null}
        </DialogBody>
        <DialogFooter>
          <OperationActions className="w-full justify-end">
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => onConfirm(confirmedProject)}
              disabled={busy || (entry.scope === 'project' && !confirmedProject)}
              data-testid="claude-code-mcp-confirm-remove"
            >
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          </OperationActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProbeConsentDialog({
  entry,
  isApp,
  busy,
  onCancel,
  onConfirm,
}: {
  entry: ClaudeCodeMcpEntry;
  isApp: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => open || onCancel()}>
      <DialogContent
        size="standard"
        variant={isApp ? 'fullscreen' : 'centered'}
        data-testid="claude-code-mcp-stdio-consent"
        data-experience={isApp ? 'app' : undefined}
      >
        <DialogHeader>
          <DialogTitle>Start {entry.name} for inspection?</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <OperationLead>
            This stdio server is a local process. Inspecting its Tools starts that
            process with the entry's command, arguments and environment, completes a
            bounded MCP handshake, and stops it again. No Tool is called.
          </OperationLead>
          <DetailNote>
            The observation comes from this Agent. A running Claude session's loaded
            state remains unknown.
          </DetailNote>
        </DialogBody>
        <DialogFooter>
          <OperationActions className="w-full justify-end">
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={onConfirm} disabled={busy} data-testid="claude-code-mcp-confirm-probe">
              {busy ? 'Inspecting…' : 'Start inspection'}
            </Button>
          </OperationActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectFields({
  mode,
  setMode,
  scope,
  setScope,
  name,
  setName,
  credentialEnv,
  projectConfirmed,
  setProjectConfirmed,
  replaceExisting,
  setReplaceExisting,
  done,
}: {
  mode: ClaudeCodeMcpHostingMode;
  setMode: (mode: ClaudeCodeMcpHostingMode) => void;
  scope: ClaudeCodeMcpWriteScope;
  setScope: (scope: ClaudeCodeMcpWriteScope) => void;
  name: string;
  setName: (name: string) => void;
  credentialEnv: string;
  projectConfirmed: boolean;
  setProjectConfirmed: (confirmed: boolean) => void;
  replaceExisting: boolean;
  setReplaceExisting: (replace: boolean) => void;
  done: boolean;
}) {
  return (
    <FormSection title="Hosting and scope">
      <FormGrid>
        <FormField id="mcp-connect-mode" label="Nession hosting mode">
          <Select
            value={mode}
            onValueChange={(value) => value && setMode(value as ClaudeCodeMcpHostingMode)}
            disabled={done}
          >
            <SelectTrigger id="mcp-connect-mode" className="w-full" size="field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">Agent-embedded · this node</SelectItem>
              <SelectItem value="server">Server-embedded · cluster</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField id="mcp-connect-scope" label="Claude scope">
          <Select
            value={scope}
            onValueChange={(value) => value && setScope(value as ClaudeCodeMcpWriteScope)}
            disabled={done}
          >
            <SelectTrigger id="mcp-connect-scope" className="w-full" size="field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local — private to this project</SelectItem>
              <SelectItem value="project">Project — shared .mcp.json</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </FormGrid>
      <FormGrid>
        <FormField id="mcp-connect-name" label="Claude entry name">
          <Input
            id="mcp-connect-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={done}
          />
        </FormField>
        <FormField label="Credential">
          <p className={cn('min-w-0 break-all', chromeMonoRole('code'))}>{credentialEnv}</p>
        </FormField>
      </FormGrid>
      {scope === 'project' ? (
        <PairCheckbox
          checked={projectConfirmed}
          label="I understand the project .mcp.json may be committed and shared; the entry references the credential, it does not contain it."
          onChange={setProjectConfirmed}
        />
      ) : null}
      <PairCheckbox
        checked={replaceExisting}
        label="Replace an existing entry with this name, in this or another scope."
        onChange={setReplaceExisting}
      />
    </FormSection>
  );
}

function PreflightSection({
  preflight,
  loading,
  localError,
  ready,
  done,
}: {
  preflight: ClaudeCodeMcpPreflight | null;
  loading: boolean;
  localError: string | null;
  ready: boolean;
  done: boolean;
}) {
  return (
    <FormSection title="Preflight" testId="claude-code-mcp-preflight">
      {preflight?.endpoint_url ? (
        <DetailFacts>
          <DetailFact label="Endpoint" mono>
            {preflight.endpoint_url}
          </DetailFact>
          {preflight.claude_version ? (
            <DetailFact label="Claude CLI" inline>
              {preflight.claude_version}
            </DetailFact>
          ) : null}
        </DetailFacts>
      ) : null}
      <div className="flex flex-col gap-1">
        {(preflight?.prerequisites ?? []).map((prerequisite) => (
          <div
            key={prerequisite.id}
            className="flex min-w-0 flex-col gap-0.5"
            data-testid={`claude-code-mcp-prerequisite-${prerequisite.id}`}
            data-state={prerequisite.state}
          >
            <p className={cn(chromeSansRole('caption'))}>
              <span className="text-muted-foreground">{prerequisite.state}</span>
              {' · '}
              {prerequisite.label}
            </p>
            {prerequisite.detail ? (
              <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                {prerequisite.detail}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {loading ? <DetailNote>Checking the endpoint and credential…</DetailNote> : null}
      {localError ? (
        <OperationError testId="claude-code-mcp-connect-error">{localError}</OperationError>
      ) : null}
      {!loading && preflight && !ready && !done ? (
        <DetailNote>
          Connect fails closed while a prerequisite is missing. Provision the endpoint's
          inbound token as {preflight.credential_env} through the Session environment
          binding, or enable MCP on the chosen host first.
        </DetailNote>
      ) : null}
      {ready && !done ? (
        <DetailNote>
          The endpoint answered an MCP handshake with this Session's credential.
          Configured is not the same as loaded: a running Claude session may need a
          reload.
        </DetailNote>
      ) : null}
    </FormSection>
  );
}

function useConnectFlow(mcp: McpState) {
  const connect = mcp.connect;
  const [mode, setMode] = useState<ClaudeCodeMcpHostingMode>('agent');
  const [scope, setScope] = useState<ClaudeCodeMcpWriteScope>('local');
  const [name, setName] = useState('nession');
  const [projectConfirmed, setProjectConfirmed] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [preflight, setPreflight] = useState<ClaudeCodeMcpPreflight | null>(null);
  const [state, setState] = useState<ClaudeCodeMcpConnectState | null>(null);
  const [writtenEntry, setWrittenEntry] = useState<ClaudeCodeMcpEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const run = useCallback(
    async (confirming: boolean) => {
      setLoading(true);
      setLocalError(null);
      try {
        let serverEndpoint: { enabled: boolean; path: string | null } | null = null;
        if (mode === 'server') {
          const info = await serverApi.mcpEndpoint();
          serverEndpoint = { enabled: info.enabled, path: info.path };
        }
        const response = await connect({
          mode,
          scope,
          name: name.trim() || 'nession',
          server_endpoint: serverEndpoint,
          confirm: confirming,
          confirm_project_write: scope !== 'project' || projectConfirmed,
          confirm_replace: replaceExisting,
        });
        if (!response) {
          setLocalError('The Agent did not answer the preflight.');
          return;
        }
        setPreflight(response.preflight);
        setState(response.state);
        setWrittenEntry(response.entry ?? null);
        if (response.state === 'error') {
          setLocalError(response.error ?? 'The preflight could not be completed.');
        }
      } catch (error) {
        setLocalError(errorText(error));
      } finally {
        setLoading(false);
      }
    },
    [connect, mode, name, projectConfirmed, replaceExisting, scope],
  );

  useEffect(() => {
    // A preflight performs a real bounded handshake, so typing a name must not
    // start one per keystroke. The short debounce also keeps a confirmation
    // checkbox from producing a burst of independent checks.
    const timer = window.setTimeout(() => {
      void run(false);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [run]);

  return {
    mode,
    setMode,
    scope,
    setScope,
    name,
    setName,
    projectConfirmed,
    setProjectConfirmed,
    replaceExisting,
    setReplaceExisting,
    preflight,
    state,
    entry: writtenEntry,
    loading,
    localError,
    run,
    ready: preflight?.ready ?? false,
    done: state === 'configured' || state === 'already_configured',
  };
}

function ConnectDialog({
  mcp,
  isApp,
  onClose,
}: {
  mcp: McpState;
  isApp: boolean;
  onClose: () => void;
}) {
  const flow = useConnectFlow(mcp);
  const {
    mode,
    setMode,
    scope,
    setScope,
    name,
    setName,
    projectConfirmed,
    setProjectConfirmed,
    replaceExisting,
    setReplaceExisting,
    preflight,
    state,
    entry,
    loading,
    localError,
    ready,
    done,
    run,
  } = flow;
  return (
    <Dialog open onOpenChange={(open) => open || onClose()}>
      <DialogContent
        size="wide"
        variant={isApp ? 'fullscreen' : 'centered'}
        data-testid="claude-code-mcp-connect-dialog"
        data-experience={isApp ? 'app' : undefined}
      >
        <DialogHeader>
          <DialogTitle>Connect Nession MCP</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 overflow-y-auto">
          <OperationLead>
            Registers the Nession MCP endpoint in this Session's Claude configuration.
            This does not enable MCP on the endpoint, mint a token or restart Claude.
          </OperationLead>
          {done ? (
            <DetailNote>
              {state === 'already_configured'
                ? 'The entry is already configured for this scope.'
                : 'The entry was written. A running Claude session may need a reload to load it.'}
              {entry?.approval === 'pending'
                ? ' This project entry also needs approval in Claude before it loads.'
                : ''}
            </DetailNote>
          ) : null}
          <FormSurface>
            <ConnectFields
              mode={mode}
              setMode={setMode}
              scope={scope}
              setScope={setScope}
              name={name}
              setName={setName}
              credentialEnv={preflight?.credential_env ?? 'NESSION_MCP_TOKEN'}
              projectConfirmed={projectConfirmed}
              setProjectConfirmed={setProjectConfirmed}
              replaceExisting={replaceExisting}
              setReplaceExisting={setReplaceExisting}
              done={done}
            />
            <PreflightSection
              preflight={preflight}
              loading={loading}
              localError={localError}
              ready={ready}
              done={done}
            />
          </FormSurface>
        </DialogBody>
        <DialogFooter>
          <OperationActions className="w-full justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              {done ? 'Close' : 'Cancel'}
            </Button>
            {done ? null : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void run(false)}
                  disabled={loading}
                >
                  Check again
                </Button>
                <Button
                  type="button"
                  onClick={() => void run(true)}
                  disabled={loading || !ready || (scope === 'project' && !projectConfirmed)}
                  data-testid="claude-code-mcp-confirm-connect"
                >
                  {loading ? 'Working…' : 'Confirm setup'}
                </Button>
              </>
            )}
          </OperationActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function McpHeader({
  mcp,
  isApp,
  hasSelection,
  showSelectionBack,
  onConnect,
}: {
  mcp: McpState;
  isApp: boolean;
  hasSelection: boolean;
  /**
   * Whether this surface owns its own Back out of a server detail. The App
   * composition pushes a server as a shell depth, so the shell header's Back is
   * the one leave; the inline control would be a second one (#1051).
   */
  showSelectionBack: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {isApp && hasSelection && showSelectionBack ? (
          <Button type="button" variant="ghost" size="sm" onClick={mcp.clearSelection}>
            <ChevronLeft className="size-4" /> Back
          </Button>
        ) : null}
        <p className={cn('min-w-0 truncate', chromeSansRole('secondary'))}>
          MCP servers for this Session
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={mcp.reload}
          disabled={mcp.loading}
          aria-label="Reload MCP configuration"
        >
          <RefreshCw className={cn('size-3.5', mcp.loading && 'animate-spin')} />
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="claude-code-mcp-connect"
          onClick={onConnect}
        >
          <PlugZap className="size-3.5" /> Connect Nession MCP
        </Button>
      </div>
    </div>
  );
}

function McpBody({
  mcp,
  isApp,
  selectedEntry,
  showSelectionBack,
  onSelectEntry,
  onOpenTool,
  onAdd,
  onEdit,
  onRemove,
  onInspect,
}: {
  mcp: McpState;
  isApp: boolean;
  selectedEntry: ClaudeCodeMcpEntry | null;
  showSelectionBack: boolean;
  onSelectEntry: (entry: ClaudeCodeMcpEntry) => void;
  onOpenTool?: (tool: ClaudeCodeMcpTool) => void;
  onAdd: () => void;
  onEdit: (entry: ClaudeCodeMcpEntry) => void;
  onRemove: (entry: ClaudeCodeMcpEntry) => void;
  onInspect: () => void;
}) {
  if (mcp.loading) {
    return (
      <p className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Reading Claude MCP configuration…
      </p>
    );
  }
  if (mcp.error && !mcp.inventory) {
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        <p className={cn('text-destructive', chromeSansRole('body'))} role="alert">
          {mcp.error}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={mcp.reload}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
      <aside
        className={cn(
          'min-h-0 border-b md:border-b-0 md:border-r',
          isApp && selectedEntry && 'hidden',
        )}
      >
        <ServerList mcp={mcp} onAdd={onAdd} onSelect={onSelectEntry} touch={isApp} />
      </aside>
      <main className={cn('flex min-h-0 flex-col', isApp && !selectedEntry && 'hidden')}>
        {selectedEntry ? (
          <ServerDetail
            mcp={mcp}
            entry={selectedEntry}
            isApp={isApp}
            showBack={showSelectionBack}
            onOpenTool={onOpenTool}
            onBack={mcp.clearSelection}
            onEdit={() => onEdit(selectedEntry)}
            onRemove={() => onRemove(selectedEntry)}
            onInspect={onInspect}
          />
        ) : (
          <div className="p-4">
            <DetailEmpty>
              Select an MCP server to inspect its source, precedence and capabilities.
            </DetailEmpty>
            <SourceList mcp={mcp} />
          </div>
        )}
      </main>
    </div>
  );
}

export function McpView({
  mcp,
  experience,
  onAdd,
  onEdit,
  onRemove,
  onSelectEntry,
  onOpenTool,
  showSelectionBack = true,
}: {
  mcp: McpState;
  experience: 'web' | 'app';
  onAdd: () => void;
  onEdit: (entry: ClaudeCodeMcpEntry) => void;
  onRemove: (entry: ClaudeCodeMcpEntry) => void;
  /**
   * App composition hook: report a chosen server so the caller can push its
   * detail as a shell depth. The default keeps the view's own selection, which
   * is what the Web master/detail and the legacy App pane use.
   */
  onSelectEntry?: (entry: ClaudeCodeMcpEntry) => void;
  /** App composition hook: a tool's schema is its own pushed depth. */
  onOpenTool?: (tool: ClaudeCodeMcpTool) => void;
  /** Whether this surface owns its own Back out of a server detail. */
  showSelectionBack?: boolean;
}) {
  const isApp = experience === 'app';
  const selectEntry = onSelectEntry ?? ((entry: ClaudeCodeMcpEntry) => void mcp.select(entry));
  const [consent, setConsent] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const selectedEntry = useMemo(() => {
    if (!mcp.selection || !mcp.inventory) {
      return null;
    }
    return (
      mcp.inventory.servers.find(
        (entry) =>
          entry.name === mcp.selection?.name && entry.scope === mcp.selection?.scope,
      ) ?? null
    );
  }, [mcp.inventory, mcp.selection]);

  const inspect = useCallback(() => {
    if (!selectedEntry) {
      return;
    }
    if (selectedEntry.transport === 'stdio') {
      setConsent(true);
      return;
    }
    void mcp.inspect(false);
  }, [mcp, selectedEntry]);

  if (!mcp.sessionKey) {
    return (
      <div className="p-6" data-testid="claude-code-mcp">
        <DetailEmpty>Select an Agent and Session to inspect Claude MCP servers.</DetailEmpty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-code-mcp">
      <McpHeader
        mcp={mcp}
        isApp={isApp}
        hasSelection={selectedEntry !== null}
        showSelectionBack={showSelectionBack}
        onConnect={() => setConnectOpen(true)}
      />
      <McpBody
        mcp={mcp}
        isApp={isApp}
        selectedEntry={selectedEntry}
        showSelectionBack={showSelectionBack}
        onSelectEntry={selectEntry}
        onOpenTool={onOpenTool}
        onAdd={onAdd}
        onEdit={onEdit}
        onRemove={onRemove}
        onInspect={inspect}
      />
      {consent && selectedEntry ? (
        <ProbeConsentDialog
          entry={selectedEntry}
          isApp={isApp}
          busy={mcp.detailLoading}
          onCancel={() => setConsent(false)}
          onConfirm={() => {
            setConsent(false);
            void mcp.inspect(true);
          }}
        />
      ) : null}
      {connectOpen ? (
        <ConnectDialog mcp={mcp} isApp={isApp} onClose={() => setConnectOpen(false)} />
      ) : null}
    </div>
  );
}

export function McpEditorHost({
  mcp,
  experience,
  editor,
  onClose,
}: {
  mcp: McpState;
  experience: 'web' | 'app';
  editor: { mode: 'add' | 'edit'; entry?: ClaudeCodeMcpEntry } | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<EditorState | null>(null);
  useEffect(() => {
    if (!editor) {
      setState(null);
      return;
    }
    setState(editor.mode === 'edit' && editor.entry ? editorForEntry(editor.entry) : editorForAdd());
  }, [editor]);
  if (!editor || !state) {
    return null;
  }
  const entry = editor.entry;
  return (
    <EntryEditor
      editor={state}
      isApp={experience === 'app'}
      busy={mcp.busy}
      error={mcp.actionError}
      currentUrl={entry?.url ?? undefined}
      currentArgCount={entry?.argument_count ?? 0}
      envNames={entry?.env_names ?? []}
      headerNames={entry?.header_names ?? []}
      onChange={(update) => setState((current) => (current ? { ...current, ...update } : current))}
      onCancel={() => {
        mcp.setActionError(null);
        onClose();
      }}
      onSave={() => {
        if (!state) {
          return;
        }
        const definition: ClaudeCodeMcpDefinition = {
          name: state.name.trim(),
          transport: state.transport,
          url: state.url.trim() ? state.url.trim() : null,
          command: state.command.trim() ? state.command.trim() : null,
          args: parseArgs(state.argsText),
          env: parseEnv(state.envText),
          headers: parseHeaders(state.headersText),
          // Typing arguments on an edit is an intent to replace them; a blank
          // field is "keep what is configured", which is the only safe default
          // because the existing arguments may contain a secret.
          replace_args:
            state.replaceArgs || (state.mode === 'edit' && state.argsText.trim().length > 0),
          replace_env: state.replaceEnv,
          replace_headers: state.replaceHeaders,
        };
        void mcp
          .mutate({
            operation: state.mode === 'add' ? 'add' : 'update',
            scope: state.scope,
            name: definition.name,
            definition,
            expected_fingerprint: state.mode === 'edit' ? (entry?.fingerprint ?? null) : null,
            confirm_project_write: state.scope !== 'project' || state.projectConfirmed,
            confirm_replace: state.replaceExisting,
          })
          .then((response) => {
            if (response?.state === 'ok') {
              onClose();
            }
          });
      }}
    />
  );
}

export function McpRemoveHost({
  mcp,
  experience,
  entry,
  onClose,
}: {
  mcp: McpState;
  experience: 'web' | 'app';
  entry: ClaudeCodeMcpEntry | null;
  onClose: () => void;
}) {
  if (!entry) {
    return null;
  }
  return (
    <RemoveDialog
      entry={entry}
      isApp={experience === 'app'}
      busy={mcp.busy}
      error={mcp.actionError}
      onCancel={() => {
        mcp.setActionError(null);
        onClose();
      }}
      onConfirm={(confirmedProject) => {
        void mcp
          .mutate({
            operation: 'remove',
            scope: entry.scope === 'project' ? 'project' : 'local',
            name: entry.name,
            expected_fingerprint: entry.fingerprint ?? null,
            confirm_project_write: entry.scope !== 'project' || confirmedProject,
            confirm_replace: false,
          })
          .then((response) => {
            if (response?.state === 'ok') {
              onClose();
            }
          });
      }}
    />
  );
}

/**
 * The MCP tab (#3600).
 *
 * It owns only the operation dialogs: the list/detail state lives in
 * [`useMcp`], whose generation guard drops answers from a previous Session. The
 * Workspace mounts this with the Session key so a Session switch unmounts every
 * pending dialog rather than leaving a write aimed at the old target.
 */
export function McpPane({
  mcp,
  experience,
}: {
  mcp: McpState;
  experience: 'web' | 'app';
}) {
  const [editor, setEditor] = useState<{ mode: 'add' | 'edit'; entry?: ClaudeCodeMcpEntry } | null>(
    null,
  );
  const [removing, setRemoving] = useState<ClaudeCodeMcpEntry | null>(null);
  return (
    <>
      <McpView
        mcp={mcp}
        experience={experience}
        onAdd={() => setEditor({ mode: 'add' })}
        onEdit={(entry) => setEditor({ mode: 'edit', entry })}
        onRemove={setRemoving}
      />
      <McpEditorHost
        mcp={mcp}
        experience={experience}
        editor={editor}
        onClose={() => setEditor(null)}
      />
      <McpRemoveHost
        mcp={mcp}
        experience={experience}
        entry={removing}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}
