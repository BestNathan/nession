import type {ReactElement} from 'react';
import type {SiteSnapshot} from '../../data/types.ts';
import {date, fmt} from '../../lib/format.ts';
import {GitHubLink} from '../../components/Links.tsx';
import {Empty, Grid, PageHead, Section} from '../../components/Primitives.tsx';

export function EvidencePage({snapshot}: {snapshot: SiteSnapshot}): ReactElement {
  const stores = snapshot.evidence?.stores || [];
  return (
    <>
      <PageHead
        kicker="TRUST AND RECORDS"
        title="Evidence, not claims."
        description="Run Stores keep the records behind engineering activity. Their existence does not prove append-only protection or independent integrity attestation."
      />
      <Section
        kicker="ORPHAN RUN STORES"
        title="Where evidence lives"
        hint="Only existing public refs are inventoried. Counts are bounded read-only facts; integrity is a separate, stricter guarantee."
      >
        {stores.length ? (
          <Grid cols="two">
            {stores.map((store) => (
              <article className="source-card" key={store.name}>
                <div className="eyebrow">{store.name}</div>
                <strong>{store.purpose}</strong>
                <p>{'Ref observed · ' + store.sha.slice(0, 12)}</p>
                <p>{'Updated ' + date(store.updated_at) + ' · ' + (store.freshness?.state || 'unavailable')}</p>
                <p>
                  {'Records ' + (store.records === null || store.records === undefined ? 'unavailable' : fmt(store.records)) +
                    (store.truncated ? ' · truncated' : '')}
                </p>
                <p>{'Lineage: public ' + store.name + ' ref at ' + store.sha.slice(0, 12)}</p>
                <p>Integrity: not independently verified by this public site</p>
                <GitHubLink text="View public branch  ↗" url={store.url} />
              </article>
            ))}
          </Grid>
        ) : (
          <Empty
            title="No existing store refs observed"
            text="The bounded public read found no present store refs. This is not evidence that no records exist."
          />
        )}
      </Section>
      <Section kicker="PROVENANCE" title="Trust has boundaries" hint="View the canonical requirements for writer authorization and integrity audits.">
        <div className="panel">
          <p>
            The current Pages build only shows branch metadata. Immutable records, authorized writers and signed
            independent anchors require their own live server-side evidence. This site never claims an audit passed merely
            because a ref exists.
          </p>
          <div className="divider" />
          <GitHubLink text="Run Store governance — Issue #1690  ↗" url="https://github.com/BestNathan/nession/issues/1690" />
        </div>
      </Section>
    </>
  );
}
