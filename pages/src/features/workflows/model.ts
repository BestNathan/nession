// Independent Pages-only workflow definition graph. Source topology comes
// from checked-in GitHub Actions YAML, never a mutable API or run history.
export const TRIGGER_LABELS: Record<string, string> = {
  issues: 'Issue',
  issue_comment: 'Issue comment',
  pull_request: 'PR',
  pull_request_target: 'Trusted PR event',
  push: 'Push',
  workflow_dispatch: 'Manual/API dispatch',
  workflow_call: 'Reusable call',
  workflow_run: 'Workflow completion',
  repository_dispatch: 'Repository dispatch',
  schedule: 'Scheduled',
};

export interface WorkflowGroup {
  id: string;
  label: string;
  detail: string;
}

export interface WorkflowNode {
  id: string;
  name: string;
  group: string;
  description: string;
  triggers: string[];
  url: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  kind: 'workflow_run' | 'workflow_call';
}

export interface WorkflowProjection {
  schema_version: number;
  source: {
    repository: string;
    main_sha: string | null;
    generated_at: string;
  };
  groups: WorkflowGroup[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowPath {
  edge: WorkflowEdge;
  key: string;
  d: string;
}

export interface WorkflowLayout {
  width: number;
  height: number;
  cardWidth: number;
  columnWidth: number;
  shown: WorkflowNode[];
  visible: Set<string>;
  positions: Map<string, {x: number; y: number}>;
  lanes: Array<{group: WorkflowGroup; x: number; width: number; count: number}>;
  paths: WorkflowPath[];
  edgeCount: number;
}

export const WORKFLOW_CANVAS_WIDTH = 1960;
const COLUMN_WIDTH = 276;
export const WORKFLOW_CARD_WIDTH = 244;
const LEFT = 34;
const START_Y = 112;
const STEP_Y = 104;

export function validateWorkflowProjection(value: unknown): WorkflowProjection {
  const projection = value as Partial<WorkflowProjection> | null;
  if (
    projection?.schema_version !== 1 ||
    projection.source?.repository !== 'BestNathan/nession' ||
    (projection.source.main_sha !== null &&
      !/^[a-f0-9]{40}$/.test(projection.source.main_sha || '')) ||
    !Array.isArray(projection.groups) ||
    projection.groups.length !== 6 ||
    !Array.isArray(projection.nodes) ||
    projection.nodes.length > 50 ||
    !Array.isArray(projection.edges) ||
    projection.edges.length > 150
  ) {
    throw new Error('Invalid workflow graph schema');
  }
  const groups = new Set(projection.groups.map((group) => group.id));
  const ids = new Set(projection.nodes.map((node) => node.id));
  if (ids.size !== projection.nodes.length || groups.size !== projection.groups.length) {
    throw new Error('Duplicate graph identity');
  }
  for (const node of projection.nodes) {
    if (
      !/^[a-z0-9-]+$/.test(node.id) ||
      !groups.has(node.group) ||
      typeof node.name !== 'string' ||
      node.name.length > 100 ||
      typeof node.description !== 'string' ||
      node.description.length > 180 ||
      !Array.isArray(node.triggers) ||
      node.triggers.some((trigger) => !TRIGGER_LABELS[trigger]) ||
      node.url !==
        'https://github.com/BestNathan/nession/blob/' +
          (projection.source.main_sha || 'main') +
          '/.github/workflows/' +
          node.id +
          '.yml'
    ) {
      throw new Error('Invalid node');
    }
  }
  for (const edge of projection.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || !['workflow_run', 'workflow_call'].includes(edge.kind)) {
      throw new Error('Invalid edge');
    }
  }
  return projection as WorkflowProjection;
}

export function layoutWorkflowGraph(
  model: WorkflowProjection,
  term: string,
  group: string,
): WorkflowLayout {
  const normalized = term.trim().toLowerCase().slice(0, 100);
  const shown = model.nodes.filter(
    (node) =>
      (group === 'all' || node.group === group) &&
      (!normalized ||
        [node.name, node.id, node.description, ...node.triggers]
          .join(' ')
          .toLowerCase()
          .includes(normalized)),
  );
  const visible = new Set(shown.map((node) => node.id));
  const maxItems = Math.max(
    1,
    ...model.groups.map((candidate) => shown.filter((node) => node.group === candidate.id).length),
  );
  const height = Math.max(390, START_Y + maxItems * STEP_Y + 54);
  const positions = new Map<string, {x: number; y: number}>();
  const lanes = model.groups.map((candidate, index) => {
    const x = LEFT + index * 320;
    const entries = shown.filter((node) => node.group === candidate.id);
    entries.forEach((node, itemIndex) => {
      positions.set(node.id, {x, y: START_Y + itemIndex * STEP_Y});
    });
    return {group: candidate, x, width: COLUMN_WIDTH, count: entries.length};
  });
  const paths: WorkflowPath[] = [];
  for (const edge of model.edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const sx = from.x + WORKFLOW_CARD_WIDTH;
    const sy = from.y + 35;
    const tx = to.x;
    const ty = to.y + 35;
    let d: string;
    if (tx > sx) {
      const bend = Math.max(46, Math.abs(tx - sx) * 0.5);
      d = 'M' + sx + ' ' + sy + ' C' + (sx + bend) + ' ' + sy + ' ' + (tx - bend) + ' ' + ty + ' ' + tx + ' ' + ty;
    } else {
      const offset = 42 + Math.abs(from.y - to.y) * 0.06;
      d = 'M' + sx + ' ' + sy + ' C' + (sx + offset) + ' ' + (sy - 30) + ' ' + (tx - offset) + ' ' + (ty - 30) + ' ' + tx + ' ' + ty;
    }
    paths.push({edge, key: edge.from + '>' + edge.to + ':' + edge.kind, d});
  }
  return {
    width: WORKFLOW_CANVAS_WIDTH,
    height,
    cardWidth: WORKFLOW_CARD_WIDTH,
    columnWidth: COLUMN_WIDTH,
    shown,
    visible,
    positions,
    lanes,
    paths,
    edgeCount: model.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)).length,
  };
}

export function selectWorkflow(
  model: WorkflowProjection | null,
  selected: string | null,
  shown: WorkflowNode[],
  visible: Set<string>,
): string | null {
  if (!model) return selected;
  if (selected && visible.has(selected)) return selected;
  return shown[0]?.id || null;
}
