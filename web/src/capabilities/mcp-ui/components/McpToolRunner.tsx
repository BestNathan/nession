import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  FormActions,
  FormField,
  FormGrid,
  FormSection,
  FormSurface,
} from '@/components/ui/configuration-form';
import { Input } from '@/components/ui/input';
import { OperationError } from '@/components/ui/operation-surface';
import { DetailNote } from '@/components/ui/resource-detail';
import { Textarea } from '@/components/ui/textarea';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import {
  boundedJson,
  defaultArguments,
  readSchema,
  schemaRecord,
  type McpSchemaField,
} from '../model';
import type { McpCallRecord, McpCallResult, McpTool } from '../types';
import type { McpRunOutcome, McpRunStatus } from '../hooks/useMcpKit';
import { McpCallHistory } from './McpCallHistory';
import { McpToolResult } from './McpToolResult';

type ArgumentMode = 'form' | 'json';

function coerce(raw: string, type: string): unknown {
  if (type === 'integer' || type === 'number') {
    return Number(raw);
  }
  if (type === 'boolean') {
    return raw === 'true';
  }
  if (type === 'array' || type === 'object') {
    return JSON.parse(raw);
  }
  return raw;
}

function buildFormArguments(
  fields: readonly McpSchemaField[],
  values: Record<string, string>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (raw === undefined || raw.trim() === '') {
      continue;
    }
    const type = field.type.includes('array') ? 'array' : field.type;
    try {
      const value = coerce(raw, type);
      if (type === 'integer' && !Number.isInteger(value)) {
        return { ok: false, error: `${field.name} must be an integer` };
      }
      if (type === 'number' && typeof value !== 'number') {
        return { ok: false, error: `${field.name} must be a number` };
      }
      if (type === 'boolean' && raw !== 'true' && raw !== 'false') {
        return { ok: false, error: `${field.name} must be true or false` };
      }
      args[field.name] = value;
    } catch {
      return { ok: false, error: `${field.name} must be valid JSON for its type` };
    }
  }
  return { ok: true, value: args };
}

function buildArguments({
  mode,
  fields,
  values,
  jsonText,
}: {
  mode: ArgumentMode;
  fields: readonly McpSchemaField[];
  values: Record<string, string>;
  jsonText: string;
}): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (mode === 'form') {
    return buildFormArguments(fields, values);
  }
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Arguments must be a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (failure) {
    return {
      ok: false,
      error: `Invalid JSON: ${failure instanceof Error ? failure.message : 'could not parse'}`,
    };
  }
}

function formValuesOf(tool: McpTool): Record<string, string> {
  return Object.fromEntries(
    Object.entries(defaultArguments(tool)).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
}

function McpArgumentFields({
  mode,
  fields,
  values,
  jsonText,
  busy,
  onField,
  onJson,
}: {
  mode: ArgumentMode;
  fields: readonly McpSchemaField[];
  values: Record<string, string>;
  jsonText: string;
  busy: boolean;
  onField: (name: string, value: string) => void;
  onJson: (text: string) => void;
}) {
  if (mode === 'json') {
    return (
      <FormField
        id="mcp-arguments-json"
        label="JSON arguments"
        description="Unknown fields are preserved exactly as typed."
      >
        <Textarea
          id="mcp-arguments-json"
          data-testid="mcp-arguments-json"
          variant="field"
          spellCheck={false}
          value={jsonText}
          disabled={busy}
          onChange={(event) => onJson(event.target.value)}
        />
      </FormField>
    );
  }
  if (fields.length === 0) {
    return <DetailNote>This Tool takes no declared arguments.</DetailNote>;
  }
  return (
    <FormGrid>
      {fields.map((field) => (
        <FormField
          key={field.name}
          id={`mcp-argument-${field.name}`}
          label={
            <span className="min-w-0 break-all">
              {field.name}
              {field.required ? ' *' : ''}
            </span>
          }
          description={field.description}
        >
          <Input
            id={`mcp-argument-${field.name}`}
            data-testid="mcp-argument"
            data-argument-name={field.name}
            type={field.type === 'integer' || field.type === 'number' ? 'number' : 'text'}
            value={values[field.name] ?? ''}
            disabled={busy}
            onChange={(event) => onField(field.name, event.target.value)}
          />
        </FormField>
      ))}
    </FormGrid>
  );
}

function McpRunConfirmation({
  tool,
  busy,
  onCancel,
  onConfirm,
}: {
  tool: McpTool;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-control)] bg-muted p-2"
      data-testid="mcp-run-confirmation"
    >
      <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
        <code>{tool.name}</code> may modify runtime state
        {tool.effect === 'write' ? ' (declared write)' : ' (effect not declared)'}. Invoke
        with the current Session&apos;s permissions?
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" data-testid="mcp-run-confirm" onClick={onConfirm} disabled={busy}>
          Invoke Tool
        </Button>
      </div>
    </div>
  );
}

interface ArgumentsSectionProps {
  tool: McpTool;
  discovered: boolean;
  invocationSupported: boolean;
  busy: boolean;
  formAvailable: boolean;
  mode: ArgumentMode;
  fields: readonly McpSchemaField[];
  values: Record<string, string>;
  jsonText: string;
  argumentError: string | null;
  error: string | null;
  status: McpRunStatus;
  confirming: boolean;
  onToggleMode: () => void;
  onReset: () => void;
  onField: (name: string, value: string) => void;
  onJson: (text: string) => void;
  onRun: () => void;
  onCancel: () => void;
  onCancelConfirm: () => void;
  onConfirm: () => void;
}

function McpArgumentsSection(props: ArgumentsSectionProps) {
  return (
    <FormSurface>
      <FormSection
        title="Arguments"
        description="Validated against the Tool's Input Schema. The draft lives only in this view."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="mcp-argument-mode-toggle"
              disabled={props.busy || !props.formAvailable}
              onClick={props.onToggleMode}
            >
              {props.mode === 'form' ? 'JSON mode' : 'Form mode'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="mcp-argument-reset"
              onClick={props.onReset}
              disabled={props.busy}
            >
              Reset
            </Button>
          </div>
        }
      >
        {!props.discovered ? (
          <DetailNote data-testid="mcp-runner-not-discovered">
            Connect and discover the server first. A Tool cannot be invoked from a
            configuration declaration alone.
          </DetailNote>
        ) : null}

        <McpArgumentFields
          mode={props.mode}
          fields={props.fields}
          values={props.values}
          jsonText={props.jsonText}
          busy={props.busy}
          onField={props.onField}
          onJson={props.onJson}
        />

        {props.argumentError ? (
          <OperationError testId="mcp-argument-error">{props.argumentError}</OperationError>
        ) : null}
        {props.error && props.status !== 'isError' ? (
          <DetailNote data-testid="mcp-runner-error">{props.error}</DetailNote>
        ) : null}

        {props.confirming ? (
          <McpRunConfirmation
            tool={props.tool}
            busy={props.busy}
            onCancel={props.onCancelConfirm}
            onConfirm={props.onConfirm}
          />
        ) : null}

        <FormActions>
          <Button
            type="button"
            data-testid="mcp-run"
            disabled={
              props.busy || !props.invocationSupported || !props.discovered || props.confirming
            }
            onClick={props.onRun}
          >
            {props.busy ? 'Running…' : 'Run tool'}
          </Button>
          {props.busy ? (
            <Button type="button" variant="outline" data-testid="mcp-run-cancel" onClick={props.onCancel}>
              Cancel run
            </Button>
          ) : null}
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Explicit <code>tools/call</code> — never automatic.
          </span>
        </FormActions>
        {!props.invocationSupported ? (
          <DetailNote data-testid="mcp-run-unsupported">
            This adapter does not support Tool invocation. The contract stays inspectable;
            no call is offered.
          </DetailNote>
        ) : null}
      </FormSection>
    </FormSurface>
  );
}

/**
 * The explicit operation depth for one Tool.
 *
 * The first click only prepares a draft; a `tools/call` happens on the Run
 * action, after validation, and after a separate confirmation when the
 * adapter has not declared the Tool read-only. A busy call can be cancelled;
 * the adapter still owns timeout, cleanup and bounded execution.
 */
export function McpToolRunner({
  tool,
  invocationSupported,
  discovered,
  status,
  error,
  result,
  history,
  onRun,
  onCancel,
  onSelectHistory,
  onResetDraft,
}: {
  tool: McpTool;
  invocationSupported: boolean;
  discovered: boolean;
  status: McpRunStatus;
  error: string | null;
  result: McpCallResult | null;
  history: readonly McpCallRecord[];
  onRun: (
    tool: McpTool,
    args: Record<string, unknown>,
    options: { confirmed: boolean },
  ) => Promise<McpRunOutcome>;
  onCancel: () => void;
  onSelectHistory: (record: McpCallRecord) => void;
  onResetDraft: (tool: McpTool) => Record<string, unknown>;
}) {
  const schema = schemaRecord(tool.inputSchema);
  const readable = useMemo(() => readSchema(tool.inputSchema), [tool.inputSchema]);
  const formAvailable = readable.form === 'object' && schema !== null;
  const [mode, setMode] = useState<ArgumentMode>(formAvailable ? 'form' : 'json');
  const [values, setValues] = useState<Record<string, string>>(() => formValuesOf(tool));
  const [jsonText, setJsonText] = useState(() =>
    boundedJson(defaultArguments(tool), 8_000).text,
  );
  const [argumentError, setArgumentError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const busy = status === 'running';

  const run = async (confirmed: boolean) => {
    const built = buildArguments({
      mode,
      fields: readable.fields,
      values,
      jsonText,
    });
    if (!built.ok) {
      setArgumentError(built.error);
      return;
    }
    setArgumentError(null);
    const outcome = await onRun(tool, built.value, { confirmed });
    if (outcome.state === 'confirmation_required') {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    if (outcome.state === 'invalid' || outcome.state === 'blocked') {
      setArgumentError(outcome.error ?? 'The call could not start.');
    }
  };

  const reset = () => {
    setValues(formValuesOf(tool));
    setJsonText(boundedJson(onResetDraft(tool), 8_000).text);
    setArgumentError(null);
    setConfirming(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="mcp-tool-runner">
      <McpArgumentsSection
        tool={tool}
        discovered={discovered}
        invocationSupported={invocationSupported}
        busy={busy}
        formAvailable={formAvailable}
        mode={mode}
        fields={readable.fields}
        values={values}
        jsonText={jsonText}
        argumentError={argumentError}
        error={error}
        status={status}
        confirming={confirming}
        onToggleMode={() => {
          if (mode === 'form') {
            const built = buildFormArguments(readable.fields, values);
            if (built.ok) {
              setJsonText(boundedJson(built.value, 8_000).text);
            }
            setMode('json');
          } else {
            setMode(formAvailable ? 'form' : 'json');
          }
        }}
        onReset={reset}
        onField={(name, value) =>
          setValues((previous) => ({ ...previous, [name]: value }))
        }
        onJson={setJsonText}
        onRun={() => {
          void run(false);
        }}
        onCancel={onCancel}
        onCancelConfirm={() => setConfirming(false)}
        onConfirm={() => {
          void run(true);
        }}
      />

      <McpToolResult result={result} status={status} error={error} />
      <McpCallHistory history={history} onSelect={onSelectHistory} />
    </div>
  );
}
