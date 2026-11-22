import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  FormActions,
  FormField,
  FormGrid,
  FormSection,
  FormSurface,
} from '@/components/ui/configuration-form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { OperationError } from '@/components/ui/operation-surface';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import { scopeLabel, transportLabel } from '../model';
import type { McpScope, McpServerEntry, McpServerMutation, McpTransport } from '../types';

const TRANSPORTS: readonly McpTransport[] = ['http', 'stdio', 'sse'];

interface EditorDraft {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  endpoint: string;
  command: string;
  argumentCount: string;
  envNames: string;
  headerNames: string;
}

function namesToText(names: readonly string[] | undefined): string {
  return (names ?? []).join(', ');
}

function parseNames(text: string): string[] {
  return text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function initialDraft(server: McpServerEntry | undefined, scopes: readonly McpScope[]): EditorDraft {
  return {
    name: server?.name ?? '',
    scope: server?.scope ?? scopes[0] ?? 'user',
    transport: server?.transport ?? 'http',
    endpoint: server?.endpoint ?? '',
    command: server?.command ?? '',
    argumentCount: server?.argumentCount === undefined ? '' : String(server.argumentCount),
    envNames: namesToText(server?.envNames),
    headerNames: namesToText(server?.headerNames),
  };
}

function validateDraft(
  draft: EditorDraft,
  scopes: readonly McpScope[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.name.trim().length === 0) {
    errors.name = 'A server name is required.';
  }
  if (!scopes.includes(draft.scope)) {
    errors.scope = 'This adapter does not write that scope.';
  }
  if (draft.transport === 'stdio') {
    if (draft.command.trim().length === 0) {
      errors.command = 'A stdio server needs an executable.';
    }
  } else if (!/^https?:\/\/\S+$/i.test(draft.endpoint.trim())) {
    errors.endpoint = 'An HTTP or SSE server needs an http(s) endpoint URL.';
  }
  const count = draft.argumentCount.trim() === '' ? 0 : Number(draft.argumentCount);
  if (!Number.isInteger(count) || count < 0) {
    errors.argumentCount = 'Argument count must be a non-negative integer.';
  }
  if (
    parseNames(draft.envNames).some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  ) {
    errors.envNames = 'Environment names must be identifiers; values never travel here.';
  }
  if (
    parseNames(draft.headerNames).some((name) => !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name))
  ) {
    errors.headerNames = 'Header names must be HTTP token names; values never travel here.';
  }
  return errors;
}

function mutationFromDraft(
  draft: EditorDraft,
  server: McpServerEntry | undefined,
): McpServerMutation {
  const envNames = parseNames(draft.envNames);
  const headerNames = parseNames(draft.headerNames);
  const count = draft.argumentCount.trim() === '' ? 0 : Number(draft.argumentCount);
  return {
    action: server ? 'update' : 'create',
    name: draft.name.trim(),
    scope: draft.scope,
    transport: draft.transport,
    ...(draft.transport === 'stdio'
      ? { command: draft.command.trim(), argumentCount: count }
      : { endpoint: draft.endpoint.trim() }),
    ...(envNames.length > 0 ? { envNames } : {}),
    ...(headerNames.length > 0 ? { headerNames } : {}),
    ...(server?.fingerprint ? { expectedFingerprint: server.fingerprint } : {}),
  };
}

function McpAdvancedFields({
  draft,
  errors,
  busy,
  update,
}: {
  draft: EditorDraft;
  errors: Record<string, string>;
  busy: boolean;
  update: (key: keyof EditorDraft, value: string) => void;
}) {
  return (
    <details className="min-w-0" data-testid="mcp-editor-advanced">
      <summary className={cn('cursor-pointer select-none text-primary', chromeSansRole('caption'))}>
        Advanced: environment and header names
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-3">
        <FormField
          id="mcp-editor-env-names"
          label="Environment names"
          description="Comma-separated names; values are credential references, never plaintext."
          error={errors.envNames}
        >
          <Input
            id="mcp-editor-env-names"
            data-testid="mcp-editor-env-names"
            value={draft.envNames}
            disabled={busy}
            onChange={(event) => update('envNames', event.target.value)}
          />
        </FormField>
        <FormField
          id="mcp-editor-header-names"
          label="Header names"
          description="Comma-separated names; values are credential references, never plaintext."
          error={errors.headerNames}
        >
          <Input
            id="mcp-editor-header-names"
            data-testid="mcp-editor-header-names"
            value={draft.headerNames}
            disabled={busy}
            onChange={(event) => update('headerNames', event.target.value)}
          />
        </FormField>
      </div>
    </details>
  );
}

function McpTransportFields({
  draft,
  errors,
  busy,
  update,
}: {
  draft: EditorDraft;
  errors: Record<string, string>;
  busy: boolean;
  update: (key: keyof EditorDraft, value: string) => void;
}) {
  if (draft.transport === 'stdio') {
    return (
      <FormGrid>
        <FormField
          id="mcp-editor-command"
          label="Executable"
          description="The executable only. Argument values are not echoed by the inventory."
          error={errors.command}
        >
          <Input
            id="mcp-editor-command"
            data-testid="mcp-editor-command"
            value={draft.command}
            disabled={busy}
            onChange={(event) => update('command', event.target.value)}
          />
        </FormField>
        <FormField
          id="mcp-editor-argument-count"
          label="Argument count"
          error={errors.argumentCount}
        >
          <Input
            id="mcp-editor-argument-count"
            data-testid="mcp-editor-argument-count"
            type="number"
            min={0}
            value={draft.argumentCount}
            disabled={busy}
            onChange={(event) => update('argumentCount', event.target.value)}
          />
        </FormField>
      </FormGrid>
    );
  }
  return (
    <FormField
      id="mcp-editor-endpoint"
      label="Endpoint URL"
      description="Sanitised: userinfo, query values and fragments are not kept."
      error={errors.endpoint}
    >
      <Input
        id="mcp-editor-endpoint"
        data-testid="mcp-editor-endpoint"
        value={draft.endpoint}
        disabled={busy}
        placeholder="https://example.invalid/mcp"
        onChange={(event) => update('endpoint', event.target.value)}
      />
    </FormField>
  );
}

function McpDefinitionFields({
  draft,
  errors,
  busy,
  editing,
  scopes,
  update,
}: {
  draft: EditorDraft;
  errors: Record<string, string>;
  busy: boolean;
  editing: boolean;
  scopes: readonly McpScope[];
  update: (key: keyof EditorDraft, value: string) => void;
}) {
  return (
    <>
      <FormField
        id="mcp-editor-name"
        label="Name"
        error={errors.name}
        errorTestId="mcp-editor-name-error"
      >
        <Input
          id="mcp-editor-name"
          data-testid="mcp-editor-name"
          value={draft.name}
          disabled={editing || busy}
          onChange={(event) => update('name', event.target.value)}
        />
      </FormField>
      <FormGrid>
        <FormField id="mcp-editor-scope" label="Scope" error={errors.scope}>
          <Select
            value={draft.scope}
            onValueChange={(value) => update('scope', value as McpScope)}
            disabled={busy}
          >
            <SelectTrigger id="mcp-editor-scope" data-testid="mcp-editor-scope" size="field">
              <span>{scopeLabel(draft.scope)}</span>
            </SelectTrigger>
            <SelectContent>
              {scopes.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {scopeLabel(candidate)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField id="mcp-editor-transport" label="Transport">
          <Select
            value={draft.transport}
            onValueChange={(value) => update('transport', value as McpTransport)}
            disabled={busy}
          >
            <SelectTrigger
              id="mcp-editor-transport"
              data-testid="mcp-editor-transport"
              size="field"
            >
              <span>{transportLabel(draft.transport)}</span>
            </SelectTrigger>
            <SelectContent>
              {TRANSPORTS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {transportLabel(candidate)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </FormGrid>
      <McpTransportFields draft={draft} errors={errors} busy={busy} update={update} />
    </>
  );
}

/**
 * The MCP configuration form.
 *
 * It is the ConfigurationForm recipe with MCP's own fields; the recipe owns
 * labels, help, validation placement and the action line. The adapter owns
 * which scopes exist, which credential references are valid, and whether the
 * write is allowed at all. Read-only definitions never reach this component.
 */
export function McpServerConfigEditor({
  server,
  scopes,
  busy,
  error,
  onSave,
  onCancel,
}: {
  server?: McpServerEntry;
  scopes: readonly McpScope[];
  busy: boolean;
  error: string | null;
  onSave: (mutation: McpServerMutation) => Promise<boolean>;
  onCancel: () => void;
}) {
  const editing = server !== undefined;
  const [draft, setDraft] = useState<EditorDraft>(() => initialDraft(server, scopes));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = (key: keyof EditorDraft, value: string) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const submit = async () => {
    const next = validateDraft(draft, scopes);
    setErrors(next);
    if (Object.keys(next).length === 0) {
      await onSave(mutationFromDraft(draft, server));
    }
  };

  return (
    <FormSurface data-testid="mcp-server-editor">
      <FormSection
        title={editing ? `Edit ${server.name}` : 'Add MCP server'}
        description="Definitions are written at the scope this adapter owns. Credential values are never edited or displayed here."
      >
        <McpDefinitionFields
          draft={draft}
          errors={errors}
          busy={busy}
          editing={editing}
          scopes={scopes}
          update={update}
        />
        <McpAdvancedFields draft={draft} errors={errors} busy={busy} update={update} />
      </FormSection>

      {error ? <OperationError testId="mcp-editor-error">{error}</OperationError> : null}

      <FormActions>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="mcp-editor-save"
          disabled={busy}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add server'}
        </Button>
      </FormActions>
    </FormSurface>
  );
}
