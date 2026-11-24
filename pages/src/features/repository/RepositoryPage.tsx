import type {ReactElement} from 'react';
import type {SiteSnapshot} from '../../data/types.ts';
import {date, fmt, pct} from '../../lib/format.ts';
import {GitHubLink} from '../../components/Links.tsx';
import {Grid, Hint, Metric, PageHead, Section} from '../../components/Primitives.tsx';

export function RepositoryPage({snapshot}: {snapshot: SiteSnapshot}): ReactElement {
  const repository = snapshot.repository || {};
  const current = repository.current || {};
  const efficiency = repository.efficiency || {};
  return (
    <>
      <PageHead
        kicker="ENGINEERING SIGNALS"
        title="Built in the open."
        description="Repository health and engineering throughput come from the existing canonical metrics pipeline. Measured SHA and age remain visible."
      />
      <Hint>
        {'Repository metrics source: ' +
          (repository.freshness?.state || 'unavailable') +
          ' · measured ' +
          date(repository.generated_at) +
          ' · site built ' +
          date(snapshot.generated_at)}
      </Hint>
      <Section
        kicker="REPOSITORY METRICS"
        title="Structure and quality"
        hint={'Current measured main revision · ' + (repository.sha ? repository.sha.slice(0, 12) : 'unavailable')}
      >
        <Grid cols="three">
          <Metric label="Tracked source lines" value={fmt(current.loc)} note={fmt(current.files) + ' files'} />
          <Metric label="Tests discovered" value={fmt(current.tests)} note="unit / integration / E2E" />
          <Metric label="Rust coverage" value={pct(current.rust_coverage)} note="line-weighted coverage" />
          <Metric label="Web coverage" value={pct(current.web_coverage)} note="measured source, not Pages" />
          <Metric label="Protocol units" value={fmt(current.protocol_units)} note="canonical catalog" />
          <Metric label="Unit test pass" value={pct(current.unit_pass)} note="excludes skipped" />
        </Grid>
      </Section>
      <Section kicker="ENGINEERING EFFICIENCY" title="Flow and throughput" hint="Rolling 7 days · window bound to metrics generation.">
        <Grid cols="four">
          <Metric label="Commits" value={fmt(efficiency.commits_7d)} note="last 7 days" />
          <Metric label="Code additions" value={fmt(efficiency.additions_7d)} note="lines · last 7 days" />
          <Metric label="Code deletions" value={fmt(efficiency.deletions_7d)} note="lines · last 7 days" />
          <Metric label="Merged PRs" value={fmt(efficiency.merged_7d)} note="last 7 days" />
        </Grid>
      </Section>
      <Section
        kicker="SOURCE"
        title="The measurements"
        hint="Measurements are published outside main to avoid committing changing counters."
      >
        <div className="panel">
          <p>{'Snapshot: ' + date(repository.generated_at) + ' · commit: ' + (repository.sha || 'unavailable')}</p>
          <GitHubLink text="Open the canonical metrics branch  ↗" url="https://github.com/BestNathan/nession/tree/metrics" />
        </div>
      </Section>
    </>
  );
}
