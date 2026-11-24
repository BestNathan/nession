import {useEffect, useRef, type ReactElement} from 'react';
import {LocalLink} from '../../../components/Links.tsx';
import {mcpSchemaFields, mcpToolRoute, type JsonSchema, type McpSnapshot, type McpTool} from './model.ts';
import {validMcpSnapshot} from '../../../data/validation.ts';
import {useUiState} from '../../../app/ui-state.tsx';

const REPO = 'https://github.com/BestNathan/nession';

function ToolSourceLink({text, url}: {text: string; url: string}): ReactElement {
  return (
    <a className="documents-source" href={url} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}

function renderFields(schema: JsonSchema | null | undefined, kind: 'Input' | 'Output'): ReactElement {
  const fields = schema ? mcpSchemaFields(schema) : [];
  return (
    <section className="documents-mcp-contract">
      <div className="documents-mcp-section-head">
        <h3>{kind + ' fields'}</h3>
        <span className="documents-mcp-section-note">
          {kind === 'Input' ? 'Registered parameters' : 'Declared structured result'}
        </span>
      </div>
      {!schema ? (
        <p className="documents-mcp-missing">
          No structured output schema is declared by this Nession Tool. Output field names, types and meanings cannot yet
          be verified from the Tool registry.
        </p>
      ) : !fields.length ? (
        <p className="documents-mcp-missing">
          {kind === 'Input'
            ? 'This Tool declares no named input parameters.'
            : 'This output schema has no named object fields. Inspect the raw schema for its exact shape.'}
        </p>
      ) : (
        <div className="documents-mcp-fields">
          {fields.map((field) => (
            <div className="documents-mcp-field" key={field.path}>
              <div className="documents-mcp-field-meta">
                <code className="documents-mcp-field-name">{field.path}</code>
                <span className="documents-mcp-type">{field.type}</span>
                <span className={'documents-mcp-required' + (field.required ? ' is-required' : '')}>
                  {field.required ? 'Required' : 'Optional'}
                </span>
              </div>
              <p className="documents-mcp-field-description">
                {field.description || 'Description not declared in the source JSON Schema.'}
              </p>
              {field.values ? <p className="documents-mcp-values">{'Allowed: ' + field.values}</p> : null}
            </div>
          ))}
        </div>
      )}
      <details className="documents-raw documents-mcp-raw">
        <summary>{kind + ' JSON Schema'}</summary>
        <pre>
          <code>{JSON.stringify(schema, null, 2)}</code>
        </pre>
      </details>
    </section>
  );
}

function ToolDetail({data, selected}: {data: McpSnapshot; selected: McpTool | undefined}): ReactElement {
  const stable = data.upstream.stable;
  return (
    <article className="documents-mcp-reader documents-reader">
      <LocalLink text="← All MCP Tools" path="/documents/mcp" className="documents-back" />
      <div className="documents-mcp-tool-detail">
        {!selected ? (
          <>
            <h2>Unknown MCP Tool</h2>
            <p>This Tool is not registered in the pinned catalog.</p>
          </>
        ) : (
          <>
            <div className="eyebrow">REGISTERED MCP TOOL</div>
            <h2>{selected.name}</h2>
            <p className="documents-mcp-method-description">{selected.description}</p>
            <div className="documents-mcp-inline-meta mono">
              <span>{'Nession MCP · ' + data.protocol_versions.join(', ')}</span>
              <ToolSourceLink
                text="Pinned Tool source ↗"
                url={REPO + '/blob/' + data.source.sha + '/crates/nession-mcp/src/tools/' + selected.name + '.rs'}
              />
            </div>
            {renderFields(selected.inputSchema, 'Input')}
            {renderFields(selected.outputSchema, 'Output')}
          </>
        )}
      </div>
      <details className="documents-mcp-spec">
        <summary>{'Protocol & provenance · MCP ' + stable.version}</summary>
        <div className="documents-mcp-spec-content">
          <p>
            {'Official stable MCP ' +
              stable.version +
              ' · previous ' +
              (stable.previous_version || 'not verified') +
              ' · Nession supports ' +
              data.protocol_versions.join(', ')}
          </p>
          <div className="documents-mcp-spec-links">
            <ToolSourceLink text="Official stable release ↗" url={stable.release_url} />
            <ToolSourceLink text="Pinned changelog ↗" url={stable.source_url} />
            <ToolSourceLink
              text="Rust registry ↗"
              url={REPO + '/blob/' + data.source.sha + '/crates/nession-mcp/src/tools/mod.rs'}
            />
          </div>
          <p className="documents-mcp-spec-source">
            {'Published source ' + data.source.sha.slice(0, 12) + ' · ' + data.tools.length + ' registered Tools'}
          </p>
          {stable.highlights.length ? (
            <>
              <h4>Official stable revision highlights</h4>
              <ul className="documents-mcp-highlights">
                {stable.highlights.map((highlight, index) => (
                  <li key={index}>{highlight}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </details>
    </article>
  );
}

export function McpPage({data, hash}: {data: McpSnapshot | null; hash: string}): ReactElement {
  const {state, actions} = useUiState();
  const readerNode = useRef<HTMLElement>(null);
  const valid = validMcpSnapshot(data) ? data : null;
  const route = mcpToolRoute(hash) || {name: null, invalid: false};
  const selected =
    valid && !route.invalid
      ? route.name
        ? valid.tools.find((tool) => tool.name === route.name)
        : valid.tools[0]
      : undefined;
  const exact = route.name !== null || route.invalid;
  const query = state.mcp.query.trim().toLocaleLowerCase();
  const found = (valid?.tools || []).filter(
    (tool) =>
      !query ||
      [tool.name, tool.description, JSON.stringify(tool.inputSchema), JSON.stringify(tool.outputSchema)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query),
  );
  useEffect(() => {
    if (readerNode.current) readerNode.current.scrollTop = 0;
  }, [selected?.name, route.invalid]);
  if (!valid) {
    return (
      <>
        <nav className="documents-breadcrumb" aria-label="Documents breadcrumb">
          <LocalLink text="Documents" path="/documents" />
          <span> / MCP</span>
        </nav>
        <h1 className="documents-heading">MCP Tools</h1>
        <p className="documents-lede">
          Canonical Nession MCP Tool contracts and independently pinned official upstream specifications.
        </p>
        <p className="documents-unavailable">
          MCP catalog unavailable or unverified. Previous support cannot be inferred from a failed source check.
        </p>
      </>
    );
  }
  return (
    <>
      <nav className="documents-breadcrumb" aria-label="Documents breadcrumb">
        <LocalLink text="Documents" path="/documents" />
        <span> / MCP</span>
      </nav>
      <h1 className="documents-heading">MCP Tools</h1>
      <p className="documents-lede">
        Canonical Nession MCP Tool contracts and independently pinned official upstream specifications.
      </p>
      <div className={'documents-mcp-layout documents-workspace' + (exact ? ' reading' : '')} data-section="mcp">
        <aside className="documents-mcp-side documents-browser-pane" aria-label="MCP Tool catalog">
          <div className="documents-browser-controls">
            <div className="eyebrow">MCP TOOL REGISTRY</div>
            <input
              className="documents-search"
              type="search"
              placeholder="Search MCP Tools or fields"
              aria-label="Search MCP Tools"
              value={state.mcp.query}
              onChange={(event) => actions.setMcpQuery(event.target.value)}
            />
            <p className="documents-count mono">
              {found.length + ' / ' + valid.tools.length + ' REGISTERED TOOLS'}
            </p>
          </div>
          <div className="documents-results documents-list-scroll" role="region" aria-label="MCP Tool list" tabIndex={0}>
            {found.map((tool) => (
              <a
                key={tool.name}
                className={'documents-entry' + (selected?.name === tool.name ? ' selected' : '')}
                href={'#/documents/mcp?tool=' + encodeURIComponent(tool.name)}
                aria-current={selected?.name === tool.name ? 'page' : undefined}
              >
                <strong>{tool.name}</strong>
                <span className="eyebrow">
                  {tool.name.startsWith('nession_server_')
                    ? 'Server'
                    : tool.name.startsWith('nession_agent_')
                      ? 'Agent'
                      : 'Tool'}
                </span>
              </a>
            ))}
            {!found.length ? <p className="documents-empty">No matching MCP Tools.</p> : null}
          </div>
        </aside>
        <section
          className="documents-reader-slot"
          role="region"
          aria-label="MCP Tool details"
          tabIndex={0}
          ref={readerNode}
        >
          <ToolDetail data={valid} selected={selected} />
        </section>
      </div>
    </>
  );
}
