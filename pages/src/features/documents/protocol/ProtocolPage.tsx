import {useEffect, useRef, useState, type ReactElement} from 'react';
import {GitHubLink, LocalLink} from '../../../components/Links.tsx';
import {
  documentsHref,
  documentsRoute,
  filterDocuments,
  protocolFieldSince,
  protocolFieldSinceTitle,
  type DocumentsSnapshot,
  type ProtocolField,
  type ProtocolGroup,
  type ProtocolHalf,
  type ProtocolVersion,
} from './model.ts';
import {useUiState} from '../../../app/ui-state.tsx';
import {validDocumentsSnapshot} from '../../../data/validation.ts';

const REPO = 'https://github.com/BestNathan/nession';

export function DocumentsIndex({
  protocolCount,
  mcpCount,
  protocolStatus,
  mcpStatus,
}: {
  protocolCount: number | null;
  mcpCount: number | null;
  protocolStatus: string;
  mcpStatus: string;
}): ReactElement {
  const categories = [
    {
      href: '/documents/protocol',
      eyebrow: '01 / NESSION',
      title: 'Protocol reference',
      description: 'Versioned Nession Protocol Units, request/response fields and verified Since Nession release boundaries.',
      count: protocolCount,
      label: 'protocol units',
      status: protocolStatus,
      action: 'Explore Protocol →',
    },
    {
      href: '/documents/mcp',
      eyebrow: '02 / MODEL CONTEXT PROTOCOL',
      title: 'MCP Tools',
      description: 'Canonical Rust-registered Tools, input JSON Schemas and verified upstream MCP specification references.',
      count: mcpCount,
      label: 'registered tools',
      status: mcpStatus,
      action: 'Explore MCP →',
    },
  ];
  return (
    <>
      <div className="eyebrow documents-kicker">NESSION / OPEN ENGINEERING</div>
      <h1 className="documents-heading">Documents</h1>
      <p className="documents-lede">
        Source-backed technical references. Choose a catalog to browse its contracts and inspect details.
      </p>
      <div className="documents-index">
        {categories.map((category) => {
          const availability =
            category.status === 'available' && Number.isSafeInteger(category.count)
              ? category.count + ' ' + category.label
              : category.status === 'loading'
                ? 'Loading public catalog…'
                : 'Catalog unavailable';
          return (
            <a className="documents-index-card" href={'#' + category.href} key={category.href}>
              <span className="eyebrow">{category.eyebrow}</span>
              <h2>{category.title}</h2>
              <p>{category.description}</p>
              <div className="documents-index-meta">
                <span className="documents-index-availability">{availability}</span>
                <strong>{category.action}</strong>
              </div>
            </a>
          );
        })}
      </div>
    </>
  );
}

function FieldTable({fields}: {fields: ProtocolField[]}): ReactElement {
  return (
    <table className="documents-field-table">
      <thead>
        <tr>
          {['Field', 'Type', 'Required', 'Since Nession', 'Description'].map((text) => (
            <th key={text}>{text}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {fields.map((field, index) => (
          <tr key={field.path + ':' + index}>
            <td className="documents-field-path">
              {field.variant ? field.path + ' (' + field.variant + ')' : field.path}
            </td>
            <td>{field.type}</td>
            <td>{field.required ? 'Yes' : 'No'}</td>
            <td className={'documents-since ' + (field.since_status || 'unknown')} title={protocolFieldSinceTitle(field)}>
              {protocolFieldSince(field)}
            </td>
            <td className="documents-field-description">{field.description || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContractSection({half, direction}: {half: ProtocolHalf | null; direction: 'request' | 'response'}): ReactElement {
  return (
    <section className="documents-contract-section">
      <div className="documents-contract-head">
        <h3>{direction === 'request' ? 'Request' : 'Response'}</h3>
        <span className="documents-alias mono">{half ? half.alias : 'No response'}</span>
      </div>
      {!half ? (
        <p className="documents-no-response">
          This contract has no response payload. A one-way operation is explicitly represented by null.
        </p>
      ) : !half.fields.length ? (
        <p className="documents-no-response">No named fields in this schema. The raw schema below remains authoritative.</p>
      ) : (
        <>
          <p className="documents-field-summary">
            {half.fields.length + ' fields · Since Nession: earliest verified release, Unreleased or Unknown.'}
          </p>
          <div className="documents-table-scroll">
            <FieldTable fields={half.fields} />
          </div>
        </>
      )}
    </section>
  );
}

function ProtocolReader({
  data,
  group,
  selected,
}: {
  data: DocumentsSnapshot;
  group: ProtocolGroup;
  selected: ProtocolVersion;
}): ReactElement {
  const [rawOpen, setRawOpen] = useState(false);
  const source = data.source;
  const observed = data.releases.filter((release) => release.status === 'available').length;
  const raw = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    protocol: group.id,
    version: selected.version,
    owner: group.owner,
    wires: group.wires,
    request: selected.request ? {alias: selected.request.alias, shape: selected.request.shape} : null,
    response: selected.response ? {alias: selected.response.alias, shape: selected.response.shape} : null,
    $defs: data.definitions,
  };
  return (
    <article className="documents-reader">
      <LocalLink text="← All protocols" path="/documents/protocol" className="documents-back" />
      <div className="eyebrow">{group.owner + ' / PROTOCOL UNIT'}</div>
      <h2>{group.id}</h2>
      <div className="documents-meta mono">
        <span>{'Wire: ' + group.wires.join(', ')}</span>
        <span>{'Contract versions: ' + group.versions.map((version) => 'v' + version.version).join(' · ')}</span>
      </div>
      <p className="documents-release-note">
        {observed
          ? observed + ' verified release snapshots inform Since Nession values; unavailable history remains Unknown.'
          : 'Historical release snapshots are unavailable; Since Nession remains Unknown until verified.'}
      </p>
      <nav className="documents-versions" aria-label="Contract version">
        {group.versions.map((version) => (
          <LocalLink
            key={version.version}
            text={'v' + version.version}
            path={documentsHref(group.id, version.version).slice(1)}
            className={'documents-version' + (version.version === selected.version ? ' active' : '')}
          />
        ))}
      </nav>
      <p className="documents-note">
        Contract v1/v2 selects the protocol definition. Since Nession refers to the release version that first supports each
        field, where verified. Missing historical evidence is Unknown.
      </p>
      <ContractSection half={selected.request} direction="request" />
      <ContractSection half={selected.response} direction="response" />
      <details
        className="documents-raw"
        open={rawOpen}
        onToggle={(event) => setRawOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>{'Full JSON Schema for v' + selected.version + ' (including $defs)'}</summary>
        {rawOpen ? (
          <pre>
            <code>{JSON.stringify(raw, null, 2)}</code>
          </pre>
        ) : null}
      </details>
      <GitHubLink
        text="View pinned codegen catalog ↗"
        url={REPO + '/blob/' + (source?.sha || '') + '/crates/nession-protocol-codegen/src/catalog.rs'}
        className="documents-source"
      />
    </article>
  );
}

export function ProtocolPage({data, hash}: {data: DocumentsSnapshot | null; hash: string}): ReactElement {
  const {state, actions} = useUiState();
  const readerNode = useRef<HTMLElement>(null);
  const route = documentsRoute(hash) || {id: null, version: null, invalid: false};
  const valid = validDocumentsSnapshot(data) && data.status === 'available' ? data : null;
  const selectedGroup = valid ? valid.protocols.find((group) => group.id === route.id) || valid.protocols[0] : undefined;
  const selected =
    selectedGroup?.versions.find((version) => version.version === route.version) || selectedGroup?.versions.at(-1);
  const validRoute =
    !route.invalid &&
    (!route.id ||
      (valid?.protocols.some((group) => group.id === route.id) &&
        (!route.version || selectedGroup?.versions.some((version) => version.version === route.version))));
  const exact = route.invalid || route.id !== null;
  const selectedKey = selectedGroup && selected ? selectedGroup.id + '@' + selected.version : 'invalid';
  useEffect(() => {
    if (readerNode.current) readerNode.current.scrollTop = 0;
  }, [selectedKey]);
  const categories = ['All', ...new Set((valid?.protocols || []).map((group) => group.owner))];
  const found = filterDocuments(valid?.protocols || [], state.documents);
  const source = valid?.source || null;
  return (
    <>
      <nav className="documents-breadcrumb" aria-label="Documents breadcrumb">
        <LocalLink text="Documents" path="/documents" />
        <span> / Protocol</span>
      </nav>
      <h1 className="documents-heading">Protocol reference</h1>
      <p className="documents-lede">
        Rust-generated Protocol Units with request/response schemas and source-verified release boundaries.
      </p>
      {!valid ? (
        <div className="panel documents-unavailable">
          <h3>Protocol catalog unavailable</h3>
          <p>The pinned Rust-generated schema could not be validated or loaded. This is not an empty protocol catalog.</p>
          <GitHubLink text="Protocol source ↗" url={REPO + '/tree/main/crates/nession-protocol'} className="documents-source" />
        </div>
      ) : (
        <>
          <div className="documents-snapshot mono">
            <span>RUST CONTRACTS / MAIN</span>
            <strong>{source?.sha.slice(0, 12)}</strong>
            <span>{valid.protocols.length + ' protocol units'}</span>
            <GitHubLink text="Architecture ↗" url={REPO + '/blob/' + (source?.sha || '') + '/docs/architecture/protocol.md'} />
          </div>
          <div className={'documents-layout documents-workspace' + (exact ? ' reading' : '')} data-section="protocol">
            <aside className="documents-browser-pane" aria-label="Protocol catalog">
              <div className="documents-browser-controls">
                <div className="eyebrow">PROTOCOL OWNERS</div>
                <div className="documents-filters">
                  {categories.map((category) => (
                    <button
                      key={category}
                      className={'documents-filter' + (state.documents.owner === category ? ' active' : '')}
                      type="button"
                      aria-pressed={state.documents.owner === category ? 'true' : 'false'}
                      onClick={() => actions.setDocuments({owner: category})}
                    >
                      {category}
                    </button>
                  ))}
                </div>
                <input
                  className="documents-search"
                  type="search"
                  placeholder="Search protocols or fields"
                  value={state.documents.query}
                  aria-label="Search protocol units"
                  onChange={(event) => actions.setDocuments({query: event.target.value})}
                />
                <p className="documents-count mono">
                  {found.length + ' / ' + valid.protocols.length + ' PROTOCOL UNITS'}
                </p>
              </div>
              <div className="documents-list-scroll" role="region" aria-label="Protocol list" tabIndex={0}>
                <div className="documents-results">
                  {found.map((group) => (
                    <a
                      key={group.id}
                      className={'documents-entry' + (group.id === selectedGroup?.id ? ' selected' : '')}
                      href={documentsHref(group.id)}
                      aria-current={group.id === selectedGroup?.id ? 'page' : undefined}
                    >
                      <div className="eyebrow">{group.owner}</div>
                      <strong>{group.id}</strong>
                      <p>{'v' + group.versions.map((version) => version.version).join(', v') + ' · ' + group.wires.join(', ')}</p>
                    </a>
                  ))}
                  {!found.length ? <p className="documents-empty">No matching protocol units.</p> : null}
                </div>
              </div>
            </aside>
            <section
              className="documents-reader-slot"
              role="region"
              aria-label="Protocol details"
              tabIndex={0}
              ref={readerNode}
            >
              {!validRoute || !selectedGroup || !selected ? (
                <article className="panel">
                  <LocalLink text="← All protocols" path="/documents/protocol" className="documents-back" />
                  <h3>Unknown protocol or version</h3>
                  <p>This protocol or contract version is not present in the pinned generated catalog.</p>
                </article>
              ) : (
                <ProtocolReader data={valid} group={selectedGroup} selected={selected} />
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
