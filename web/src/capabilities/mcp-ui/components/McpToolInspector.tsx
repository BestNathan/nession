import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DetailHeader,
  DetailNote,
  DetailSurface,
} from '@/components/ui/resource-detail';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import { outputSchemaNote } from '../model';
import type { McpCallRecord, McpCallResult, McpTool } from '../types';
import type { McpRunOutcome, McpRunStatus } from '../hooks/useMcpKit';
import { McpSchemaViewer } from './McpSchemaViewer';
import { McpToolRunner } from './McpToolRunner';

function effectLabel(tool: McpTool): string {
  switch (tool.effect) {
    case 'read':
      return 'Read only';
    case 'write':
      return 'May modify state';
    default:
      return 'Side effects unknown';
  }
}

function McpToolContract({ tool, onRun }: { tool: McpTool; onRun: () => void }) {
  return (
    <>
      <McpSchemaViewer
        title="Input schema"
        schema={tool.inputSchema}
        testId="mcp-schema-input"
        missingNote="This Tool advertised no input schema."
      />
      <McpSchemaViewer
        title="Output schema"
        schema={tool.outputSchema}
        testId="mcp-schema-output"
        missingNote={outputSchemaNote(tool)}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" data-testid="mcp-open-runner" onClick={onRun}>
          Run tool
        </Button>
        <DetailNote className="m-0">
          Arguments and results open in a separate step; inspecting a Tool never calls it.
        </DetailNote>
      </div>
    </>
  );
}

/**
 * The Tool contract is the landing view; invocation is a separate depth.
 *
 * Contract shows both schemas (readable and complete raw) and never implies
 * that a missing external `outputSchema` is the same thing as a result. Run
 * holds the draft, the explicit action, the result tabs and local history.
 */
export function McpToolInspector({
  serverName,
  tool,
  discovered,
  invocationSupported,
  status,
  error,
  result,
  history,
  onRun,
  onCancelRun,
  onSelectHistory,
  onResetDraft,
  panel: controlledPanel,
  onPanelChange,
}: {
  serverName: string;
  tool: McpTool;
  discovered: boolean;
  invocationSupported: boolean;
  status: McpRunStatus;
  error: string | null;
  result: McpCallResult | null;
  history: readonly McpCallRecord[];
  onRun: (
    tool: McpTool,
    args: Record<string, unknown>,
    options: { confirmed: boolean },
  ) => Promise<McpRunOutcome>;
  onCancelRun: () => void;
  onSelectHistory: (record: McpCallRecord) => void;
  onResetDraft: (tool: McpTool) => Record<string, unknown>;
  /** App hosts control the depth; Web may let the inspector own it. */
  panel?: 'contract' | 'run';
  onPanelChange?: (panel: 'contract' | 'run') => void;
}) {
  const [internalPanel, setInternalPanel] = useState<'contract' | 'run'>('contract');
  const panel = controlledPanel ?? internalPanel;
  const setPanel = (next: 'contract' | 'run') => {
    if (onPanelChange) {
      onPanelChange(next);
    } else {
      setInternalPanel(next);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 p-3" data-testid="mcp-tool-inspector">
      <DetailSurface>
        <DetailHeader
          eyebrow={`MCP Tool · ${serverName}`}
          title={<span className="min-w-0 break-all">{tool.name}</span>}
          titleTestId="mcp-tool-title"
          badges={
            <span
              className={cn(
                'shrink-0 rounded-[var(--nession-radius-control)] bg-muted px-1.5 py-0.5 text-muted-foreground',
                chromeSansRole('caption'),
              )}
              data-testid="mcp-tool-effect"
            >
              {effectLabel(tool)}
            </span>
          }
          description={tool.description ?? 'No description was advertised for this Tool.'}
        />
        <div
          className="flex min-w-0 flex-wrap gap-1"
          role="tablist"
          aria-label="Tool detail"
        >
          {(['contract', 'run'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={panel === id}
              data-testid={`mcp-tool-panel-${id}`}
              onClick={() => setPanel(id)}
              className={cn(
                'rounded-[var(--nession-radius-control)] px-2 py-1 transition-colors',
                chromeSansRole('caption'),
                panel === id
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {id === 'contract' ? 'Contract' : 'Run'}
            </button>
          ))}
        </div>
      </DetailSurface>

      {panel === 'contract' ? (
        <McpToolContract tool={tool} onRun={() => setPanel('run')} />
      ) : (
        <McpToolRunner
          key={tool.name}
          tool={tool}
          invocationSupported={invocationSupported}
          discovered={discovered}
          status={status}
          error={error}
          result={result}
          history={history}
          onRun={onRun}
          onCancel={onCancelRun}
          onSelectHistory={onSelectHistory}
          onResetDraft={onResetDraft}
        />
      )}
    </div>
  );
}
