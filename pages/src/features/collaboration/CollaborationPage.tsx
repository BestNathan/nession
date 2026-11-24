import {Fragment, type ReactElement} from 'react';
import type {PublicIssue, PublicPull, SiteSnapshot} from '../../data/types.ts';
import {date, fmt} from '../../lib/format.ts';
import {GitHubLink, LocalLink} from '../../components/Links.tsx';
import {Callout, Empty, Entry, Hint, List, PageHead, Section} from '../../components/Primitives.tsx';

function IssueEvidencePane({issue, snapshot}: {issue: PublicIssue; snapshot: SiteSnapshot}): ReactElement {
  const references = issue.pr_references || {};
  const pulls = Array.isArray(references.prs) ? references.prs : [];
  const observed = Array.isArray(issue.agent_runs) ? issue.agent_runs : [];
  const source = snapshot.work?.agent_run_source;
  return (
    <div className="issue-pr-evidence">
      <span className="issue-pr-source">GitHub Timeline · PR cross-references (not ownership or SC proof)</span>
      {references.status === 'unavailable' ? (
        <span>Timeline unavailable</span>
      ) : (
        <>
          {!pulls.length ? (
            <span>
              {references.status === 'truncated'
                ? 'No PR references in this incomplete snapshot'
                : 'No PR cross-references observed'}
            </span>
          ) : null}
          {pulls.map((pull) => (
            <GitHubLink key={pull.number} text={'PR #' + pull.number + ' · GitHub cross-reference'} url={pull.url} />
          ))}
          {references.status === 'truncated' ? <span>Timeline truncated · other references may be missing</span> : null}
        </>
      )}
      <span className="issue-pr-source">Pinned Metrics · Issue Agent Runs · PR linkage: Unlinked</span>
      {source === 'unavailable' ? (
        <span>Issue Agent source unavailable · no run verified</span>
      ) : !observed.length ? (
        <span>Agent runs: Not observed in bounded source window</span>
      ) : (
        observed.map((run) => {
          const agent = run.agent_id || 'Unknown Agent';
          const role = run.role || 'Unknown role';
          return (
            <Fragment key={run.run_id + ':' + run.attempt}>
              <GitHubLink
                text={
                  'Agent ' +
                  role +
                  ' / ' +
                  agent +
                  ' · ' +
                  run.workflow +
                  ' · run ' +
                  run.run_id +
                  ' / attempt ' +
                  run.attempt
                }
                url={run.url}
              />
              <span className="mono">
                {'Target ' +
                  (run.target_sha?.slice(0, 12) || 'unknown') +
                  ' · ' +
                  (run.verification === 'github_run_verified'
                    ? 'GitHub Run identity verified'
                    : 'Not independently verified') +
                  ' · tokens ' +
                  fmt(run.tokens_total) +
                  ' · duration ' +
                  (run.duration_ms === null ? 'N/A' : String(run.duration_ms) + 'ms')}
              </span>
            </Fragment>
          );
        })
      )}
      {source === 'truncated' ? <span>Agent source truncated · other runs may be missing</span> : null}
      <LocalLink text="Inspect bounded Issue evidence  ↗" path={'/work/issue/' + issue.number} className="source-link" />
    </div>
  );
}

function PullEvidencePane({pull}: {pull: PublicPull}): ReactElement {
  const sha = pull.workflow?.head_sha;
  const reviews = pull.review || {};
  const event = reviews.latest;
  return (
    <div className="work-evidence">
      <span className="mono">{sha ? 'PR HEAD ' + sha.slice(0, 12) : 'PR HEAD unavailable'}</span>
      {(
        [
          ['ci', 'Quality'],
          ['e2e', 'E2E'],
        ] as const
      ).map(([key, label]) => {
        const run = pull.workflow?.[key];
        return run ? (
          <GitHubLink
            key={key}
            text={label + ' · ' + run.status + ' · run ' + run.run_id + ' / attempt ' + run.attempt}
            url={run.url}
          />
        ) : (
          <span key={key}>{label + ': Not observed'}</span>
        );
      })}
      <span className="issue-pr-source">PR Review · observed exact-HEAD event, not overall approval</span>
      {reviews.status === 'unavailable' ? (
        <span>Review source unavailable</span>
      ) : (
        <>
          {event ? (
            <GitHubLink
              text={
                'Review · ' +
                event.state.replaceAll('_', ' ') +
                ' · review ' +
                event.review_id +
                ' · HEAD ' +
                event.commit_sha.slice(0, 12)
              }
              url={event.url}
            />
          ) : (
            <span>Review: Not observed at current HEAD</span>
          )}
          {reviews.status === 'truncated' ? <span>Reviews truncated · current-HEAD event may be missing</span> : null}
        </>
      )}
      <LocalLink text="Inspect exact-HEAD PR evidence  ↗" path={'/work/pr/' + pull.number} className="source-link" />
    </div>
  );
}

export function CollaborationPage({snapshot}: {snapshot: SiteSnapshot}): ReactElement {
  const work = snapshot.work || {};
  const lineage = work.lineage;
  const listing = (type: 'Issues' | 'Pull Requests', items: PublicIssue[] | PublicPull[], availability?: string): ReactElement => {
    const section = (
      <Section kicker={'GITHUB / ' + type.toUpperCase()} title={type} hint="Recently updated · open items">
        {availability !== 'available' ? (
          <Empty
            title="Snapshot unavailable"
            text="GitHub API data could not be fetched or validated. This is not evidence of zero active items."
          />
        ) : !items.length ? (
          <Empty title="No open items" text="No items returned by the current bounded snapshot." />
        ) : (
          <List>
            {type === 'Pull Requests'
              ? (items as PublicPull[]).map((pull) => (
                  <Entry
                    key={pull.number}
                    title={'#' + pull.number + '  ' + pull.title}
                    subtitle={pull.state + ' · GitHub source'}
                    value="PR"
                    url={pull.url}
                    stamp={date(pull.updated_at)}
                    pane={<PullEvidencePane pull={pull} />}
                  />
                ))
              : (items as PublicIssue[]).map((issue) => (
                  <Entry
                    key={issue.number}
                    title={'#' + issue.number + '  ' + issue.title}
                    subtitle={
                      issue.state +
                      ' · source GitHub · observed Agent runs (7d): ' +
                      (issue.observed_agent_runs_7d === null || issue.observed_agent_runs_7d === undefined
                        ? 'Not observed'
                        : fmt(issue.observed_agent_runs_7d))
                    }
                    value="Issue"
                    url={issue.url}
                    stamp={date(issue.updated_at)}
                    pane={<IssueEvidencePane issue={issue} snapshot={snapshot} />}
                  />
                ))}
          </List>
        )}
      </Section>
    );
    return section;
  };

  return (
    <>
      <PageHead
        kicker="OPEN COLLABORATION"
        title="Work in progress."
        description="A read-only view of recently updated public Issues and PRs. No stage or SC verdict is inferred from an Issue title or workflow name."
      />
      {listing('Issues', work.issues || [], work.issues_status)}
      {listing('Pull Requests', work.pulls || [], work.pulls_status)}
      <Hint>
        {work.workflow_runs_status === 'available'
          ? 'Run evidence is sampled from the 100 most recent GitHub Actions runs. Not observed does not imply no historical run.'
          : 'CI/E2E workflow source unavailable; missing evidence is not a successful or failed run.'}
      </Hint>
      {['verified', 'truncated'].includes(lineage?.status || '') && Array.isArray(lineage?.edges) && lineage.edges.length ? (
        <Section
          kicker="SOURCE-AUTHENTICATED HISTORY"
          title="Verified historical Agent lineage"
          hint="Independent original Worker, Publisher, Writer, Store and PR HEAD proof. Historical identity only; not current approval or SC Pass."
        >
          <article className="panel">
            {lineage.edges.slice(0, 12).map((edge) => (
              <div className="issue-pr-evidence" key={edge.issue + ':' + edge.pr_number + ':' + edge.run_id}>
                <LocalLink
                  text={'Issue #' + edge.issue + ' · inspect authenticated source'}
                  path={'/work/issue/' + edge.issue}
                  className="source-link"
                />
                <LocalLink
                  text={'PR #' + edge.pr_number + ' · historical HEAD ' + edge.pr_head_sha.slice(0, 12)}
                  path={'/work/pr/' + edge.pr_number}
                  className="source-link"
                />
                <GitHubLink
                  text={'Developer ' + edge.agent_id + ' · Run ' + edge.run_id + ' / attempt ' + edge.attempt}
                  url={edge.source_url}
                />
                <span>
                  {'Logical Slice: ' +
                    (edge.slice_id ?? 'Unlinked') +
                    ' · current Review: Unknown · Acceptance SC: Unknown'}
                </span>
              </div>
            ))}
            {lineage.truncated ? <p className="hint">Historical source window truncated; additional verified edges may be absent.</p> : null}
          </article>
        </Section>
      ) : (
        <Callout>
          No independently verified causal edge in this bounded source window. Missing authenticated producer data remains
          Unknown / Unlinked.
        </Callout>
      )}
    </>
  );
}

export function LineageDetail({
  snapshot,
  kind,
  number,
}: {
  snapshot: SiteSnapshot;
  kind: 'issue' | 'pr';
  number: number;
}): ReactElement {
  const source = snapshot.work?.lineage;
  const status = ['verified', 'truncated'].includes(source?.status || '') ? source?.status : 'unavailable';
  const records =
    status === 'unavailable'
      ? []
      : (source?.edges || []).filter((edge) => (kind === 'issue' ? edge.issue === number : edge.pr_number === number)).slice(0, 12);
  const observations = snapshot.work?.agent_result_observations;
  return (
    <Section
      kicker="CAUSAL PROVENANCE"
      title="Authenticated historical Agent edges"
      hint="Only exact Issue/PR, Agent Run/Attempt and historical PR HEAD bindings from the source-gated public projection."
    >
      <article className="panel">
        <p className="mono">{'Public Lineage source: ' + status + ' · generated ' + date(snapshot.generated_at)}</p>
        {status === 'unavailable' ? (
          <p>
            Authenticated Producer and Publisher source unavailable. Issue → implementing PR → Agent/Slice: Unknown /
            Unlinked.
          </p>
        ) : !records.length ? (
          <p>
            No matching authenticated edges in this bounded source window. Earlier work may exist; no causal link is
            inferred.
          </p>
        ) : (
          records.map((edge) => (
            <div className="issue-pr-evidence" key={edge.pr_number + ':' + edge.run_id}>
              <GitHubLink
                text={'PR #' + edge.pr_number + ' · attested historical HEAD ' + edge.pr_head_sha.slice(0, 12) + ' ↗'}
                url={'https://github.com/BestNathan/nession/pull/' + edge.pr_number}
              />
              <GitHubLink
                text={'Agent ' + edge.role + ' / ' + edge.agent_id + ' · Run ' + edge.run_id + ' / attempt ' + edge.attempt + ' ↗'}
                url={edge.source_url}
              />
              <span className="mono">
                {'Producer source ref ' + edge.source_ref_sha.slice(0, 12) + ' · exact historical PR HEAD ' + edge.pr_head_sha}
              </span>
              <span>
                {'Logical Slice: ' +
                  (edge.slice_id ?? 'Unlinked') +
                  ' · current PR approval: Unknown · Acceptance SC: Unknown'}
              </span>
            </div>
          ))
        )}
        {status === 'truncated' || source?.truncated === true ? (
          <p>Lineage window is truncated; additional historical edges may be absent.</p>
        ) : null}
        {kind === 'issue' && ['available', 'truncated'].includes(observations?.status || '') ? (
          <>
            {(() => {
              const observed = (observations?.records || []).filter((edge) => edge.issue === number).slice(0, 12);
              if (!observed.length) return null;
              return (
                <>
                  <p>Pinned Agent Store observations · unverified source claims only</p>
                  {observed.map((edge) => (
                    <div className="issue-pr-evidence" key={edge.run_id + ':' + edge.attempt}>
                      <GitHubLink
                        text={'Observed ' + edge.role + ' / ' + edge.agent_id + ' · Run ' + edge.run_id + ' / attempt ' + edge.attempt + ' ↗'}
                        url={edge.source_url}
                      />
                      <span>
                        Claimed implementing PR: Unknown / Unlinked · Logical Slice: Unlinked · Acceptance SC: Unknown
                      </span>
                    </div>
                  ))}
                </>
              );
            })()}
            {observations?.truncated ? (
              <p>Pinned Store observation window truncated; absence does not mean no run.</p>
            ) : null}
          </>
        ) : null}
        <p>
          A historical attested PR HEAD does not prove current HEAD, merge approval, successful SC or orphan Store
          immutability.
        </p>
      </article>
    </Section>
  );
}

export function WorkDetailPage({
  snapshot,
  kind,
  number,
}: {
  snapshot: SiteSnapshot;
  kind: 'issue' | 'pr';
  number: number;
}): ReactElement {
  const issues = snapshot.work?.issues || [];
  const pulls = snapshot.work?.pulls || [];
  const isIssue = kind === 'issue';
  const source: Array<PublicIssue | PublicPull> = isIssue ? issues : pulls;
  const sourceState = isIssue ? snapshot.work?.issues_status : snapshot.work?.pulls_status;
  const item = sourceState === 'available' ? source.find((candidate) => candidate.number === number) : undefined;
  if (!item) {
    const historical = snapshot.work?.lineage;
    const matched =
      ['verified', 'truncated'].includes(historical?.status || '') &&
      historical?.edges?.some((edge) => (isIssue ? edge.issue === number : edge.pr_number === number));
    if (matched) {
      return (
        <>
          <PageHead
            kicker="HISTORICAL SOURCE"
            title={(isIssue ? 'Issue #' : 'PR #') + number + ' · authenticated historical lineage'}
            description="Read-only original Producer/Publisher proof. Current Issue, Review and SC state are not inferred."
          />
          <LineageDetail snapshot={snapshot} kind={kind} number={number} />
        </>
      );
    }
    return (
      <Empty
        title="Evidence unavailable in this bounded snapshot"
        text={
          'The requested ' +
          (isIssue ? 'Issue' : 'PR') +
          ' is not among the recent public records. This is not evidence that it does not exist or was accepted.'
        }
      />
    );
  }
  const pull = isIssue ? null : (item as PublicPull);
  const head = pull?.workflow?.head_sha;
  const proof = snapshot.work?.acceptance_e2e || {status: 'unavailable', records: []};
  const isSource = proof.status === 'available' || proof.status === 'truncated';
  const matching = (proof.records || [])
    .filter((record) => (isIssue ? record.issue === number : record.target_sha === pull?.workflow?.head_sha))
    .slice(0, 12);
  const store = snapshot.work?.agent_store_readiness;
  const storeStatus = store?.status || 'unavailable';
  const explanation =
    {
      missing: 'Agent Store branch not found',
      empty: 'Branch exists but has no published source entries',
      present_unverified: 'Source tree exists; no v2 receipt or writer origin has been independently authenticated',
      unavailable: 'Unable to verify pinned Agent Store snapshot',
    }[storeStatus] || 'Source not authenticated';
  const metricsSource = snapshot.work?.agent_run_source;
  return (
    <>
      <LocalLink text="← All recent work" path="/work" className="source-link" />
      <PageHead
        kicker={isIssue ? 'ISSUE EVIDENCE' : 'PR EVIDENCE'}
        title={'#' + item.number + ' · ' + item.title}
        description={
          'Public source observations only · updated ' +
          date(item.updated_at) +
          ' · site snapshot ' +
          date(snapshot.generated_at)
        }
      />
      <Section kicker="CANONICAL SOURCE" title="GitHub record" hint="Open authoritative source for the current state.">
        <article className="panel">
          <GitHubLink text={(isIssue ? 'Issue' : 'PR') + ' #' + number + ' · ' + item.state + ' ↗'} url={item.url} />
          <p>
            This record is sampled from a bounded build-time GitHub snapshot. Owner, stage and SC approval are not
            inferred.
          </p>
        </article>
      </Section>
      {isIssue ? (
        <>
          <Section
            kicker="ISSUE REFERENCES"
            title="PR mentions only"
            hint="A GitHub cross-reference is NOT verified implementing PR ownership or Agent causality."
          >
            <article className="panel">
              {(() => {
                const refs = (item as PublicIssue).pr_references;
                const linked = refs?.prs || [];
                if (refs?.status === 'unavailable') return <p>Timeline source unavailable</p>;
                return (
                  <>
                    {!linked.length ? <p>No PR mention observed in the bounded Timeline window.</p> : null}
                    {linked.map((ref) => (
                      <GitHubLink key={ref.number} text={'GitHub cross-reference · PR #' + ref.number + ' ↗'} url={ref.url} />
                    ))}
                    {refs?.status === 'truncated' ? <p>Timeline truncated · references may be missing.</p> : null}
                  </>
                );
              })()}
              <p>Implementation relationship: Unknown / Unlinked</p>
            </article>
          </Section>
          <Section
            kicker="METRICS SOURCE"
            title="Observed Agent Runs"
            hint="Canonical workflow Run/Attempt is independent of implementing PR/SC Acceptance."
          >
            <article className="panel">
              {metricsSource === 'unavailable' ? (
                <p>Source unavailable · do not infer zero Agent runs.</p>
              ) : !(item as PublicIssue).agent_runs?.length ? (
                <p>No Agent Run observed in the bounded window.</p>
              ) : null}
              {((item as PublicIssue).agent_runs || []).map((run) => (
                <div className="issue-pr-evidence" key={run.run_id + ':' + run.attempt}>
                  <GitHubLink text={'Run ' + run.run_id + ' / attempt ' + run.attempt + ' ↗'} url={run.url} />
                  <span>
                    {'Role ' +
                      (run.role || 'Unknown') +
                      ' · Agent ' +
                      (run.agent_id || 'Unknown') +
                      ' · Provider ' +
                      (run.provider || 'Unknown') +
                      ' · workflow ' +
                      run.github_workflow}
                  </span>
                  <span className="mono">
                    {'Target SHA ' +
                      (run.target_sha || 'Unknown') +
                      ' · ' +
                      (run.verification === 'github_run_verified' ? 'Run identity verified' : 'Not independently verified')}
                  </span>
                  <span>
                    {'Tokens ' + fmt(run.tokens_total) + ' · duration ' + fmt(run.duration_ms) + 'ms · PR linkage: Unlinked'}
                  </span>
                </div>
              ))}
              {metricsSource === 'truncated' ? (
                <p>Source truncated · more runs may exist beyond the sampled window.</p>
              ) : null}
            </article>
          </Section>
        </>
      ) : (
        <Section
          kicker="EXACT HEAD"
          title="Workflow and Review evidence"
          hint="Only observed PR HEAD runs/events at the recorded SHA. No overall approval, SC verdict or implementation attribution."
        >
          <article className="panel">
            <p className="mono">{'Observed HEAD: ' + (head || 'Unavailable')}</p>
            {(
              [
                ['ci', 'Quality'],
                ['e2e', 'E2E'],
              ] as const
            ).map(([key, label]) => {
              const run = pull?.workflow?.[key];
              return run ? (
                <GitHubLink
                  key={key}
                  text={label + ' · ' + run.status + ' · Run ' + run.run_id + ' / attempt ' + run.attempt + ' ↗'}
                  url={run.url}
                />
              ) : (
                <p key={key}>{label + ': Not observed in sampled Actions window'}</p>
              );
            })}
            {pull?.review?.latest ? (
              <GitHubLink
                text={
                  'Review event ' +
                  pull.review.latest.state.replaceAll('_', ' ') +
                  ' · HEAD ' +
                  pull.review.latest.commit_sha +
                  ' · review ' +
                  pull.review.latest.review_id +
                  ' ↗'
                }
                url={pull.review.latest.url}
              />
            ) : (
              <p>
                {pull?.review?.status === 'unavailable' ? 'Review source unavailable' : 'No same-HEAD Review observed'}
              </p>
            )}
            {pull?.review?.status === 'truncated' ? <p>Review source truncated · additional reviews may exist.</p> : null}
            <p>Issue implementation/Agent Slice: Unknown / Unlinked</p>
            <p>Acceptance SC verdict: Not independently observed here.</p>
          </article>
        </Section>
      )}
      <LineageDetail snapshot={snapshot} kind={kind} number={number} />
      <Section
        kicker="TEST EVIDENCE · NOT ACCEPTANCE SC"
        title="Source-bound per-ID E2E receipts"
        hint="Results come from a bounded pinned acceptance-results checkout and independent GitHub Run/Attempt and Ingest checks. An E2E Pass does NOT mean an Acceptance SC Pass."
      >
        <article className="panel">
          <p>{'Canonical test source: ' + proof.status + ' · pinned ref ' + (proof.source_sha?.slice(0, 12) || 'unavailable')}</p>
          {!isSource ? <p>Trusted E2E source unavailable. No verdict inferred.</p> : null}
          {isSource && !matching.length ? <p>No verified per-ID E2E in the sampled source window.</p> : null}
          {matching.map((record) => (
            <div className="issue-pr-evidence" key={record.id + ':' + record.run_id + ':' + record.attempt}>
              <GitHubLink
                text={record.id + ' · ' + record.result + ' · Run ' + record.run_id + ' / attempt ' + record.attempt + ' ↗'}
                url={record.url}
              />
              <span className="mono">
                {'Evidence target SHA ' + record.target_sha + ' · E2E only, not a Success Criterion verdict'}
              </span>
            </div>
          ))}
          {proof.status === 'truncated' ? <p>E2E source truncated · older or additional runs may exist.</p> : null}
          <p>{'Agent Store source readiness: ' + storeStatus + ' · ' + explanation}</p>
          {store?.sha ? (
            <GitHubLink text={'Pinned Agent Store source ' + store.sha.slice(0, 12) + ' ↗'} url={store.url || ''} />
          ) : null}
          <p>Trusted Acceptance SC: Unknown / Not independently observed.</p>
          <p>
            {'Implementing PR / logical Slice: ' +
              (snapshot.work?.lineage?.status === 'unavailable'
                ? 'Unknown / Unlinked'
                : 'Source-gated; inspect each independently attested edge.')}
          </p>
        </article>
      </Section>
      <Callout>
        No unverified Issue → implementing PR → Agent/Slice causality or orphan-store integrity is presented as
        established.
      </Callout>
    </>
  );
}
