import { useEffect, useState } from 'react';

import { DetailEmpty, DetailNote, DetailSection } from '@/components/ui/resource-detail';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import { boundedJson, redactSecrets, redactText } from '../model';
import type { McpCallResult } from '../types';

type ResultMode = 'structured' | 'content' | 'raw';

function defaultMode(result: McpCallResult): ResultMode {
  if (result.structuredContent !== undefined) {
    return 'structured';
  }
  if (result.content && result.content.length > 0) {
    return 'content';
  }
  return 'raw';
}

function ResultPre({ text, testId }: { text: string; testId: string }) {
  return (
    <pre
      data-testid={testId}
      className={cn(
        'max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-[var(--nession-radius-control)] bg-muted p-2',
        chromeMonoRole('code'),
      )}
    >
      {text}
    </pre>
  );
}

interface PreparedContent {
  block: { type: string; [key: string]: unknown };
  text: string | null;
  redacted: boolean;
}

function ResultContentBlocks({ content }: { content: readonly PreparedContent[] }) {
  if (content.length === 0) {
    return (
      <DetailEmpty data-testid="mcp-result-content-empty">
        No <code>content</code> blocks in this result.
      </DetailEmpty>
    );
  }
  return (
    <ul className="flex min-w-0 flex-col gap-2" data-testid="mcp-result-content">
      {content.map((entry, index) => (
        <li
          key={index}
          data-testid="mcp-result-content-block"
          data-block-type={entry.block.type}
          className="min-w-0"
        >
          {entry.text !== null ? (
            <ResultPre text={entry.text} testId="mcp-result-content-text" />
          ) : entry.block.type === 'image' ? (
            <DetailNote>
              Image content block
              {typeof entry.block.mimeType === 'string' ? ` (${entry.block.mimeType})` : ''};
              binary data is not rendered inline.
            </DetailNote>
          ) : (
            <ResultPre
              text={boundedJson(redactSecrets(entry.block).value).text}
              testId="mcp-result-content-unknown"
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function McpResultBody({
  mode,
  hasStructured,
  structured,
  content,
  raw,
}: {
  mode: ResultMode;
  hasStructured: boolean;
  structured: { text: string; truncated: boolean };
  content: readonly PreparedContent[];
  raw: { text: string; truncated: boolean };
}) {
  if (mode === 'structured') {
    return !hasStructured ? (
      <DetailEmpty data-testid="mcp-result-structured-empty">
        No <code>structuredContent</code> in this result.
      </DetailEmpty>
    ) : (
      <div className="min-w-0">
        <ResultPre text={structured.text} testId="mcp-result-structured" />
        {structured.truncated ? (
          <DetailNote data-testid="mcp-result-truncated">
            The result was bounded for display.
          </DetailNote>
        ) : null}
      </div>
    );
  }
  if (mode === 'content') {
    return <ResultContentBlocks content={content} />;
  }
  return (
    <div className="min-w-0">
      <ResultPre text={raw.text} testId="mcp-result-raw" />
      {raw.truncated ? (
        <DetailNote data-testid="mcp-result-raw-truncated">
          The raw envelope was bounded for display.
        </DetailNote>
      ) : null}
    </div>
  );
}

/**
 * A result preserves each part the MCP envelope carries: typed
 * `structuredContent`, ordered `content` blocks, `isError`, and the complete
 * raw envelope. None is reconstructed from another, and an unknown block type
 * stays inspectable as raw JSON.
 *
 * This is presentation of an answer the adapter already bounded; credential
 * values are redacted for display as a second guard, never treated as a schema.
 */
export function McpToolResult({
  result,
  status,
  error,
}: {
  result: McpCallResult | null;
  status: string;
  error: string | null;
}) {
  const [mode, setMode] = useState<ResultMode>('structured');

  useEffect(() => {
    if (result) {
      setMode(defaultMode(result));
    }
  }, [result]);

  if (!result) {
    return (
      <DetailSection title="Result" testId="mcp-result">
        {error ? (
          <DetailNote data-testid="mcp-result-error">{error}</DetailNote>
        ) : (
          <DetailEmpty data-testid="mcp-result-empty">
            No invocation yet. Inspecting a Tool never triggers a call.
          </DetailEmpty>
        )}
      </DetailSection>
    );
  }

  const structured = redactSecrets(result.structuredContent);
  const raw = redactSecrets(result.raw);
  const content = (result.content ?? []).map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      const redacted = redactText(block.text);
      return { block, text: redacted.text, redacted: redacted.redacted };
    }
    return { block, text: null, redacted: false };
  });
  const redacted = structured.redacted || raw.redacted || content.some((entry) => entry.redacted);
  const tabs: readonly { id: ResultMode; label: string }[] = [
    { id: 'structured', label: 'Structured' },
    { id: 'content', label: 'Content' },
    { id: 'raw', label: 'Raw' },
  ];

  return (
    <DetailSection title="Result" testId="mcp-result">
      {result.isError || status === 'isError' ? (
        <DetailNote data-testid="mcp-result-is-error" className="text-destructive">
          Tool returned an error (<code>isError: true</code>). The payload below is the
          Tool&apos;s answer, not a transport failure.
        </DetailNote>
      ) : error ? (
        <DetailNote data-testid="mcp-result-error">{error}</DetailNote>
      ) : null}

      {redacted ? (
        <DetailNote data-testid="mcp-result-redacted">
          Secret-looking values were redacted for display.
        </DetailNote>
      ) : null}

      <div className="flex min-w-0 flex-wrap gap-1" role="tablist" aria-label="Tool result">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            data-testid={`mcp-result-tab-${tab.id}`}
            onClick={() => setMode(tab.id)}
            className={cn(
              'rounded-[var(--nession-radius-control)] px-2 py-1 transition-colors',
              chromeSansRole('caption'),
              mode === tab.id
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <McpResultBody
        mode={mode}
        hasStructured={result.structuredContent !== undefined}
        structured={boundedJson(structured.value)}
        content={content}
        raw={boundedJson(raw.value)}
      />
    </DetailSection>
  );
}
