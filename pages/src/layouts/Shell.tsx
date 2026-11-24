import type {ReactElement, ReactNode} from 'react';
import {currentNavRoute, NAV_ITEMS, navHref} from '../app/navigation.ts';
import type {ResourceStatus} from '../app/resources.tsx';
import {date} from '../lib/format.ts';
import type {SiteSnapshot} from '../data/types.ts';

export function Shell({
  page,
  hash,
  site,
  children,
}: {
  page: 'index' | 'workflows';
  hash: string;
  site: {status: ResourceStatus; data: SiteSnapshot | null};
  children: ReactNode;
}): ReactElement {
  const standalone = page === 'workflows';
  const active = currentNavRoute(standalone ? '/workflows.html' : '/', hash);
  const freshness = standalone
    ? 'Trusted source, bounded public projection · no browser token'
    : site.status === 'available' && site.data?.generated_at
      ? 'Generated ' + date(site.data.generated_at) + ' · public snapshot, not live presence'
      : site.status === 'unavailable'
        ? 'Engineering snapshot unavailable'
        : 'Public snapshots • source-backed, never live presence';
  return (
    <>
      <header className="topbar">
        <a href={standalone ? 'index.html#/' : '#/'} className="brand" aria-label="Nession home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>
            ness<span className="brand-muted">ion</span>
          </span>{' '}
          <span className="brand-note">/ LAB</span>
        </a>
        <nav className="navigation" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.route}
              href={navHref(item, standalone)}
              data-route={item.route}
              aria-label={item.ariaLabel}
              aria-current={active === item.route ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <a
          className="top-source"
          href={
            standalone
              ? 'https://github.com/BestNathan/nession/actions'
              : 'https://github.com/BestNathan/nession'
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          {standalone ? 'Actions' : 'GitHub'} <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="footer">
        <span>NESSION / OPEN ENGINEERING</span>
        <span id={standalone ? undefined : 'freshness'}>{freshness}</span>
        {standalone ? (
          <a
            href="https://github.com/BestNathan/nession/issues/2056"
            target="_blank"
            rel="noopener noreferrer"
          >
            Topology contract ↗
          </a>
        ) : (
          <a
            href="https://github.com/BestNathan/nession/issues/1782"
            target="_blank"
            rel="noopener noreferrer"
          >
            About this observatory ↗
          </a>
        )}
      </footer>
    </>
  );
}
