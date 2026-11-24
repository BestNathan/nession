// Canonical Pages navigation inventory. Both entrypoints consume this single
// owner; neither HTML file hand-maintains nav links.
export type NavItem = Readonly<{
  route: string;
  label: string;
  file?: string;
  ariaLabel?: string;
}>;

export const NAV_ITEMS: readonly NavItem[] = Object.freeze([
  {route: '/', label: 'Overview'},
  {route: '/agents', label: 'AI Agents'},
  {route: '/work', label: 'Collaboration'},
  {route: '/workflows', label: 'Workflows', file: 'workflows.html'},
  {route: '/knowledge', label: 'Knowledge'},
  {route: '/documents', label: 'Documents'},
  {route: '/prototypes', label: 'Prototypes', ariaLabel: 'Explore interactive product prototypes'},
  {route: '/repository', label: 'Repository'},
  {route: '/evidence', label: 'Evidence'},
]);

export function isStandalone(pathname: string): boolean {
  return pathname.endsWith('/workflows.html');
}

export function currentNavRoute(pathname: string, hash: string): string {
  if (isStandalone(pathname)) return '/workflows';
  const raw = hash.replace(/^#/, '') || '/';
  if (raw.startsWith('/agents/') || raw.startsWith('/agents?')) return '/agents';
  if (raw.startsWith('/work/')) return '/work';
  if (raw === '/knowledge' || raw.startsWith('/knowledge?')) return '/knowledge';
  if (raw === '/documents' || raw.startsWith('/documents?') || raw.startsWith('/documents/')) {
    return '/documents';
  }
  return raw;
}

export function navHref(item: NavItem, standalone: boolean): string {
  return item.file || ((standalone ? 'index.html#' : '#') + item.route);
}
