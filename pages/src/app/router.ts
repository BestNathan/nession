// Typed hash router. URL owns route/selection/version/outcome; the parser is
// pure so it can be tested without a browser.
export const ORDINARY_ROUTES = Object.freeze([
  '/',
  '/agents',
  '/work',
  '/repository',
  '/evidence',
  '/prototypes',
  '/knowledge',
  '/documents',
]);

export type AgentRole = 'developer' | 'reviewer' | 'acceptor' | 'auditor';
export type AgentPeriod = '7d' | '30d';
export type AgentOutcome = 'success' | 'failure' | 'cancelled' | 'timed_out' | 'unknown';

export type WorkMatch = Readonly<{kind: 'issue' | 'pr'; number: number}>;
export type AgentMatch = Readonly<{role: AgentRole; id: string}>;
export type AgentSelection = Readonly<{period: AgentPeriod; outcome: AgentOutcome | null}>;

export type RouteState = Readonly<{
  raw: string;
  route: string;
  detail: boolean;
  agentPath: boolean;
  agentMatch: AgentMatch | null;
  invalidAgentReference: boolean;
  workMatch: WorkMatch | null;
  invalidWorkReference: boolean;
  needsSite: boolean;
}>;

const WORK_DETAIL = /^\/work\/(issue|pr)\/([1-9][0-9]{0,8})$/;
const AGENT_DETAIL =
  /^\/agents\/(developer|reviewer|acceptor|auditor)\/([a-z][a-z0-9-]{0,62})(?:\?(?:window=(?:7d|30d)|outcome=[a-z_]+|[a-z_]+=[a-z0-9_-]+)(?:&[a-z_]+=[a-z0-9_-]+)*)?$/;

export function parseRoute(hash: string): RouteState {
  const raw = hash.replace(/^#/, '') || '/';
  const workMatchRaw = raw.match(WORK_DETAIL);
  const agentMatchRaw = raw.match(AGENT_DETAIL);
  const agentPath = raw.startsWith('/agents/') || raw.startsWith('/agents?');
  const detail = raw.startsWith('/work/') && !ORDINARY_ROUTES.includes(raw);
  const protocolPath =
    raw === '/documents/protocol' ||
    raw.startsWith('/documents/protocol?') ||
    raw.startsWith('/documents?protocol=') ||
    raw.startsWith('/documents?v=');
  const route = agentPath
    ? '/agents'
    : workMatchRaw
      ? '/work'
      : raw === '/knowledge' || raw.startsWith('/knowledge?')
        ? '/knowledge'
        : raw === '/documents/mcp' || raw.startsWith('/documents/mcp?')
          ? '/documents/mcp'
          : protocolPath
            ? '/documents/protocol'
            : raw === '/documents' || raw.startsWith('/documents?')
              ? '/documents'
              : ORDINARY_ROUTES.includes(raw)
                ? raw
                : detail
                  ? '/work'
                  : raw === '/'
                    ? '/'
                    : '/missing';
  const workMatch = workMatchRaw
    ? ({kind: workMatchRaw[1] as 'issue' | 'pr', number: Number(workMatchRaw[2])} as const)
    : null;
  const agentMatch = agentMatchRaw
    ? ({role: agentMatchRaw[1] as AgentRole, id: agentMatchRaw[2] as string} as const)
    : null;
  return {
    raw,
    route,
    detail,
    agentPath,
    agentMatch,
    invalidAgentReference: agentPath && raw.startsWith('/agents/') && !agentMatch,
    workMatch,
    invalidWorkReference: detail && !workMatch,
    needsSite: Boolean(workMatch) || ['/', '/agents', '/work', '/repository', '/evidence'].includes(route),
  };
}

export function agentSelection(hash: string): AgentSelection {
  const raw = hash.replace(/^#/, '');
  const query = raw.split('?')[1] || '';
  const params = new URLSearchParams(query);
  const outcome = params.get('outcome');
  return {
    period: params.get('window') === '30d' ? '30d' : '7d',
    outcome: ['success', 'failure', 'cancelled', 'timed_out', 'unknown'].includes(outcome || '')
      ? (outcome as AgentOutcome)
      : null,
  };
}

export function agentDetailPath(
  role: string,
  id: string,
  period: AgentPeriod,
  outcome: AgentOutcome | null = null,
): string {
  const query = new URLSearchParams();
  if (period === '30d') query.set('window', '30d');
  if (outcome) query.set('outcome', outcome);
  return '/agents/' + role + '/' + id + (query.toString() ? '?' + query.toString() : '');
}

function routeLabel(route: string): string {
  if (route === '/') return 'Overview';
  if (route === '/work') return 'Collaboration';
  return route.slice(1).replace(/^\w/, (x) => x.toUpperCase());
}

export function loadingTitle(state: RouteState): string {
  return routeLabel(state.route) + ' — Nession';
}

export function readyTitle(state: RouteState): string {
  // The pre-migration renderer only prettified '/work' while loading; the
  // settled title is derived from the route slice (e.g. 'Work — Nession').
  const label = state.detail
    ? 'Evidence'
    : state.route === '/'
      ? 'Overview'
      : state.route === '/missing'
        ? 'Unavailable'
        : state.route.slice(1).replace(/^\w/, (x) => x.toUpperCase());
  return label + ' — Nession';
}
