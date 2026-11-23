import { DetailEmpty, DetailSection } from '@/components/ui/resource-detail';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import { boundedJson, readSchema, schemaRecord, type McpSchemaField } from '../model';

function SchemaFields({ fields }: { fields: readonly McpSchemaField[] }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div
        className={cn(
          'flex items-baseline gap-3 border-b border-border py-1 text-muted-foreground',
          chromeSansRole('caption'),
        )}
        aria-hidden="true"
      >
        <span className="min-w-0 flex-1">Parameter</span>
        <span className="w-24 shrink-0">Type</span>
      </div>
      <ul className="flex min-w-0 flex-col">
        {fields.map((field) => (
          <li
            key={field.name}
            data-testid="mcp-schema-field"
            className="flex min-w-0 flex-col gap-1 border-b border-border py-2 last:border-b-0"
          >
            <div className="flex min-w-0 items-baseline gap-3">
              <code className={cn('min-w-0 break-all', chromeMonoRole('code'))}>
                {field.name}
              </code>
              {field.required ? (
                <span
                  className={cn('shrink-0 text-muted-foreground', chromeSansRole('caption'))}
                >
                  required
                </span>
              ) : null}
              <span
                className={cn(
                  'ml-auto w-24 shrink-0 text-right text-muted-foreground',
                  chromeMonoRole('code'),
                )}
              >
                {field.type}
                {field.itemsType ? ` of ${field.itemsType}` : ''}
              </span>
            </div>
            {field.description || field.choices ? (
              <p className={cn('min-w-0 text-muted-foreground', chromeSansRole('caption'))}>
                {field.description}
                {field.choices
                  ? `${field.description ? ' ' : ''}Allowed: ${field.choices.join(', ')}`
                  : ''}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RawSchema({ schema, testId }: { schema: unknown; testId: string }) {
  const raw = boundedJson(schema);
  return (
    <details className="min-w-0" data-testid={`${testId}-raw-details`}>
      <summary className={cn('cursor-pointer select-none text-primary', chromeSansRole('caption'))}>
        View raw JSON Schema
      </summary>
      <pre
        data-testid={`${testId}-raw`}
        className={cn(
          'mt-2 max-h-72 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-[var(--nession-radius-control)] bg-muted p-2',
          chromeMonoRole('code'),
        )}
      >
        {raw.text}
      </pre>
    </details>
  );
}

/**
 * One Tool schema, readable and complete.
 *
 * The readable projection is the schema's own top-level properties; the raw
 * view is the untouched JSON. A schema that cannot be read is not repaired or
 * hidden — the raw bytes remain the source of truth. A missing output schema is
 * a sentence about the external provider, never an empty section.
 */
export function McpSchemaViewer({
  title,
  schema,
  testId,
  missingNote,
  level = 'h3',
}: {
  title: string;
  schema: unknown;
  testId: string;
  missingNote?: string;
  level?: 'h2' | 'h3';
}) {
  const record = schemaRecord(schema);
  const readable = readSchema(schema);

  return (
    <DetailSection
      title={title}
      level={level}
      testId={testId}
      action={
        record ? (
          <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            {readable.form === 'object'
              ? `${readable.fields.length} ${readable.fields.length === 1 ? 'field' : 'fields'}`
              : 'raw only'}
          </span>
        ) : undefined
      }
    >
      {!record ? (
        <DetailEmpty data-testid={`${testId}-missing`}>
          {missingNote ?? 'No schema was advertised. The raw payload is unavailable too.'}
        </DetailEmpty>
      ) : (
        <>
          {readable.form === 'object' ? (
            readable.fields.length === 0 ? (
              <DetailEmpty>No top-level properties in this schema.</DetailEmpty>
            ) : (
              <div data-testid={`${testId}-fields`}>
                <SchemaFields fields={readable.fields} />
              </div>
            )
          ) : (
            <DetailEmpty data-testid={`${testId}-unreadable`}>
              This schema is not a readable object schema. The complete raw JSON is shown
              below.
            </DetailEmpty>
          )}
          <RawSchema schema={record} testId={testId} />
        </>
      )}
    </DetailSection>
  );
}
