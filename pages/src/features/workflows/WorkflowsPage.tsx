import {useEffect, useMemo, useState, type ReactElement} from 'react';
import {WorkflowLink} from '../../components/Links.tsx';
import {
  TRIGGER_LABELS,
  layoutWorkflowGraph,
  selectWorkflow,
  validateWorkflowProjection,
  type WorkflowNode,
  type WorkflowProjection,
} from './model.ts';

type LoadState = {status: 'loading'} | {status: 'available'; model: WorkflowProjection} | {status: 'unavailable'};

export function WorkflowsPage(): ReactElement {
  const [load, setLoad] = useState<LoadState>({status: 'loading'});
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');

  useEffect(() => {
    let cancelled = false;
    async function loadProjection(): Promise<void> {
      try {
        const response = await fetch(new URL('data/workflows.json', document.baseURI), {cache: 'no-cache'});
        if (!response.ok) throw new Error('Source projection unavailable');
        const model = validateWorkflowProjection(await response.json());
        if (!cancelled) setLoad({status: 'available', model});
      } catch (error) {
        console.error('Workflow projection unavailable', error);
        if (!cancelled) setLoad({status: 'unavailable'});
      }
    }
    void loadProjection();
    return () => {
      cancelled = true;
    };
  }, []);

  const model = load.status === 'available' ? load.model : null;
  const layout = useMemo(
    () => (model ? layoutWorkflowGraph(model, search, group) : null),
    [model, search, group],
  );
  const effective = layout ? selectWorkflow(model, selected, layout.shown, layout.visible) : null;
  useEffect(() => {
    if (effective !== selected) setSelected(effective);
  }, [effective, selected]);

  const select = (id: string | null): void => {
    setSelected(id);
  };
  const dependency = (id: string): void => {
    setSearch('');
    setGroup('all');
    setSelected(id);
  };
  const summary =
    load.status === 'available' && layout
      ? layout.shown.length +
        ' / ' +
        load.model.nodes.length +
        ' core workflows · ' +
        layout.edgeCount +
        ' / ' +
        load.model.edges.length +
        ' declared connections'
      : load.status === 'unavailable'
        ? 'Source topology unavailable; no graph or success status can be inferred.'
        : 'Loading checked-in workflow definitions…';
  const source =
    load.status === 'available'
      ? 'Built from checked-in GitHub Actions definitions · source ' +
        (load.model.source.main_sha ? load.model.source.main_sha.slice(0, 12) : 'revision unavailable') +
        ' · generated ' +
        new Date(load.model.source.generated_at).toLocaleString('en-US', {timeZone: 'UTC'}) +
        ' UTC'
      : load.status === 'unavailable'
        ? 'Inspect the canonical .github/workflows files in the source repository.'
        : '';

  return (
    <>
      <div className="page-head workflow-hero">
        <div className="eyebrow">ENGINEERING SYSTEM / SOURCE TOPOLOGY</div>
        <h1>Inside the workflow.</h1>
        <p className="lede">
          How Nession coordinates issue audit, agent execution, quality, acceptance, trusted evidence and release. Every
          solid connection is declared by a checked-in GitHub Action.
        </p>
      </div>
      <section className="workflow-overview" aria-label="Topology coverage">
        <div id="workflow-summary" className="workflow-summary" role="status">
          {summary}
        </div>
        <p id="workflow-source" className="workflow-source">
          {source}
        </p>
      </section>
      <div className="workflow-toolbar">
        <label className="workflow-search-label" htmlFor="workflow-search">
          Find workflow
          <input
            type="search"
            id="workflow-search"
            placeholder="Search name, trigger or responsibility…"
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="workflow-filter-label" htmlFor="workflow-group">
          Focus on
          <select id="workflow-group" value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="all">All stages</option>
            {(model?.groups || []).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="workflow-view" aria-label="Workflow dependency graph">
        <div className="workflow-section-heading">
          <div>
            <div className="eyebrow">DECLARED RELATIONSHIPS</div>
            <h2>Execution topology</h2>
          </div>
          <div className="workflow-legend">
            <span>
              <i className="legend-line" /> workflow_run (completed event)
            </span>
            <span>
              <i className="legend-line legend-call" /> workflow_call (reusable workflow)
            </span>
          </div>
        </div>
        <p className="workflow-explainer">
          Arrows mean a downstream workflow explicitly subscribes to an upstream workflow completion, or invokes a reusable
          workflow. They do <strong>not</strong> guarantee successful execution or attested Acceptance. Other events (PR,
          Issue, push, manual, dispatch) are visible in node details, not drawn as causal workflow edges.
        </p>
        <div className="workflow-graph-scroll" id="workflow-graph-scroll" tabIndex={0} aria-label="Scrollable dependency graph">
          <WorkflowGraph load={load} layout={layout} selected={effective} onSelect={select} />
        </div>
        <div className="workflow-bottom">
          <div className="workflow-roster" id="workflow-roster" aria-label="Accessible workflow list">
            {layout && model
              ? layout.shown.map((node) => {
                  const groupLabel = model.groups.find((candidate) => candidate.id === node.group)?.label || '';
                  return (
                    <button
                      key={node.id}
                      className="workflow-roster-row"
                      type="button"
                      data-workflow-id={node.id}
                      aria-pressed={node.id === effective ? 'true' : 'false'}
                      onClick={() => select(node.id)}
                    >
                      <span className="workflow-roster-name">{node.name}</span>
                      <span className="workflow-roster-group">{groupLabel}</span>
                    </button>
                  );
                })
              : null}
            {load.status === 'available' && layout && !layout.shown.length ? (
              <p className="workflow-no-match">No matching workflows.</p>
            ) : null}
          </div>
          <aside className="workflow-detail" id="workflow-detail" aria-live="polite">
            <WorkflowDetail
              load={load}
              model={model}
              selected={effective}
              onDependency={dependency}
            />
          </aside>
        </div>
      </section>
      <p className="workflow-disclaimer">
        This is a build-time snapshot of the workflow <strong>definitions</strong>, not a live Actions dashboard. It does
        not infer Issue → implementing PR → Agent provenance, passing CI/E2E, Success Criteria approval or orphan-store
        integrity. For runs and actual results follow the linked canonical GitHub sources.
      </p>
    </>
  );
}

function WorkflowGraph({
  load,
  layout,
  selected,
  onSelect,
}: {
  load: LoadState;
  layout: ReturnType<typeof layoutWorkflowGraph> | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
}): ReactElement {
  if (load.status === 'unavailable') {
    return (
      <div className="workflow-graph" id="workflow-graph" role="group" aria-label="GitHub Actions definitions by lifecycle stage">
        <p className="workflow-no-match">Workflow definition source unavailable.</p>
      </div>
    );
  }
  if (load.status !== 'available' || !layout) {
    return <div className="workflow-graph" id="workflow-graph" role="group" aria-label="GitHub Actions definitions by lifecycle stage" />;
  }
  const model = load.model;
  const related = (node: WorkflowNode): boolean =>
    Boolean(
      selected &&
        model.edges.some(
          (edge) =>
            (edge.from === selected && edge.to === node.id) || (edge.to === selected && edge.from === node.id),
        ),
    );
  return (
    <div
      className="workflow-graph"
      id="workflow-graph"
      role="group"
      aria-label="GitHub Actions definitions by lifecycle stage"
      style={{width: layout.width + 'px', height: layout.height + 'px'}}
    >
      <svg className="workflow-lines" viewBox={'0 0 ' + layout.width + ' ' + layout.height} width={layout.width} height={layout.height} aria-hidden="true">
        <defs>
          {(
            [
              ['workflow_run', '#438870'],
              ['workflow_call', '#b87d55'],
            ] as const
          ).map(([kind, color]) => (
            <marker
              key={kind}
              id={'workflow-arrow-' + kind}
              markerWidth={8}
              markerHeight={8}
              refX={7}
              refY={3}
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 7 3 L 0 6 z" fill={color} />
            </marker>
          ))}
        </defs>
        {layout.paths.map((path) => (
          <path
            key={path.key}
            d={path.d}
            className={
              'workflow-edge ' +
              path.edge.kind +
              (selected && (path.edge.from === selected || path.edge.to === selected) ? ' active' : '')
            }
            markerEnd={'url(#workflow-arrow-' + path.edge.kind + ')'}
            data-edge-key={path.key}
          />
        ))}
      </svg>
      {layout.lanes.map((lane) => (
        <div
          key={lane.group.id}
          className={'workflow-lane' + (lane.count ? '' : ' workflow-lane-empty')}
          style={{left: lane.x + 'px', width: lane.width + 'px'}}
        >
          {lane.group.label}
          <small>{lane.group.detail}</small>
        </div>
      ))}
      {layout.shown.map((node) => {
        const position = layout.positions.get(node.id);
        if (!position) return null;
        return (
          <button
            key={node.id}
            className={
              'workflow-node' +
              (node.id === selected ? ' selected' : '') +
              (related(node) ? ' related' : '')
            }
            type="button"
            data-workflow-id={node.id}
            style={{
              left: position.x + 'px',
              top: position.y + 'px',
              width: layout.cardWidth + 'px',
            }}
            aria-pressed={node.id === selected ? 'true' : 'false'}
            onClick={() => onSelect(node.id)}
          >
            <span className="workflow-node-title">{node.name}</span>
            <span className="workflow-node-meta">
              {node.triggers
                .slice(0, 2)
                .map((trigger) => TRIGGER_LABELS[trigger] || trigger)
                .join(' · ')}
            </span>
          </button>
        );
      })}
      {!layout.shown.length ? (
        <p className="workflow-no-match">
          No matching definitions in this bounded graph. Clear the filters to restore the full topology.
        </p>
      ) : null}
    </div>
  );
}

function WorkflowDetail({
  load,
  model,
  selected,
  onDependency,
}: {
  load: LoadState;
  model: WorkflowProjection | null;
  selected: string | null;
  onDependency: (id: string) => void;
}): ReactElement {
  if (load.status === 'unavailable') {
    return <WorkflowLink text="Open GitHub Actions ↗" href="https://github.com/BestNathan/nession/actions" />;
  }
  if (load.status === 'loading' || !model) {
    return (
      <>
        <div className="eyebrow">INSPECT A WORKFLOW</div>
        <h3>Select a node</h3>
        <p>Choose a workflow from the map or the list to view its exact triggers, declared dependencies and source file.</p>
      </>
    );
  }
  const node = model.nodes.find((candidate) => candidate.id === selected);
  if (!node) {
    return <p>No workflow is selected.</p>;
  }
  const group = model.groups.find((candidate) => candidate.id === node.group);
  const nodeById = new Map(model.nodes.map((candidate) => [candidate.id, candidate]));
  const incoming = model.edges.filter((edge) => edge.to === node.id);
  const outgoing = model.edges.filter((edge) => edge.from === node.id);
  const groupList = (label: string, edges: typeof incoming, getId: (edge: (typeof incoming)[number]) => string): ReactElement => (
    <div className="workflow-detail-block">
      <h4>{label}</h4>
      {!edges.length ? <p>None declared between the curated workflows.</p> : null}
      {edges.map((edge) => {
        const target = getId(edge);
        return (
          <button
            key={edge.from + '>' + edge.to + ':' + edge.kind}
            className="workflow-dependency"
            type="button"
            onClick={() => onDependency(target)}
          >
            {(nodeById.get(target)?.name || target) + ' · ' + edge.kind}
          </button>
        );
      })}
    </div>
  );
  return (
    <>
      <div className="eyebrow">{group?.label}</div>
      <h3>{node.name}</h3>
      <p>{node.description}</p>
      <div className="workflow-detail-block">
        <h4>GitHub event triggers</h4>
        <div className="workflow-chips">
          {node.triggers.map((trigger) => (
            <span className="workflow-chip" key={trigger}>
              {TRIGGER_LABELS[trigger] || trigger}
            </span>
          ))}
        </div>
      </div>
      {groupList('Subscribed upstream / callers', incoming, (edge) => edge.from)}
      {groupList('Downstream consumers / reusable calls', outgoing, (edge) => edge.to)}
      <WorkflowLink text="Open pinned workflow source ↗" href={node.url} />
      <WorkflowLink
        text="Inspect GitHub Actions runs ↗"
        href={'https://github.com/BestNathan/nession/actions/workflows/' + node.id + '.yml'}
      />
      <p className="workflow-note">
        This source declaration is not evidence that a run executed, completed, or passed.
      </p>
    </>
  );
}
