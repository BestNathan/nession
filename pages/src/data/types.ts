// Public snapshot contracts consumed by the Pages UI. These mirror the
// validated public projections; the producer scripts remain the schema owner.
export interface Freshness {
  state: string;
  age_hours?: number | null;
}

export interface SourceInfo {
  repository?: string;
  main_sha?: string | null;
  metrics_sha?: string | null;
  acceptance_results_sha?: string | null;
  generated_at?: string;
}

export interface RepositoryCurrent {
  loc?: number | null;
  files?: number | null;
  tests?: number | null;
  rust_coverage?: number | null;
  web_coverage?: number | null;
  protocol_units?: number | null;
  unit_pass?: number | null;
}

export interface RepositoryEfficiency {
  commits_7d?: number | null;
  additions_7d?: number | null;
  deletions_7d?: number | null;
  merged_7d?: number | null;
  open_issues?: number | null;
  open_prs?: number | null;
}

export interface RepositorySection {
  available?: boolean;
  sha?: string | null;
  generated_at?: string | null;
  freshness?: Freshness;
  current?: RepositoryCurrent;
  efficiency?: RepositoryEfficiency;
}

export interface AgentSummary {
  runs_7d?: number | null;
  runs_30d?: number | null;
  tokens_7d?: number | null;
  tokens_observed_runs?: number | null;
  duration_7d?: number | null;
  duration_avg_7d?: number | null;
  duration_observed_runs?: number | null;
  tools_7d?: number | null;
  tools_observed_runs?: number | null;
  cost_7d?: number | null;
  cost_observed_runs?: number | null;
}

export interface DistributionItem {
  name: string;
  count: number;
}

export interface DistributionPanel {
  available?: boolean;
  items?: DistributionItem[];
}

export interface AgentRosterItem {
  id: string;
  role: string;
  provider?: string;
  observed_7d?: number | null;
}

export interface AgentRun {
  run_id: number;
  attempt: number;
  workflow: string;
  github_workflow?: string;
  issue?: number | null;
  outcome: string;
  provider: string;
  observed_at: string;
  duration_ms: number;
  url: string;
}

export interface AgentOutcomeItem {
  id: string;
  role: string;
  provider?: string;
  total: number;
  success: number;
  failure: number;
  cancelled: number;
  timed_out: number;
  unknown: number;
  recent?: AgentRun[];
}

export interface AgentOutcomeWindow {
  status?: string;
  unattributed?: number | null;
  truncated?: boolean;
  items?: AgentOutcomeItem[];
}

export interface AgentsSection {
  available?: boolean;
  generated_at?: string | null;
  freshness?: Freshness;
  summary?: AgentSummary;
  roster?: AgentRosterItem[];
  outcomes?: Partial<Record<'7d' | '30d', AgentOutcomeWindow>>;
  distribution?: Partial<
    Record<
      '7d' | '30d',
      {providers?: DistributionPanel; workflows?: DistributionPanel}
    >
  >;
}

export interface PullReference {
  number: number;
  url: string;
}

export interface IssueReferences {
  status?: string;
  prs?: PullReference[];
}

export interface IssueRun {
  run_id: number;
  attempt: number;
  workflow: string;
  github_workflow?: string;
  target_sha?: string | null;
  agent_id?: string | null;
  role?: string | null;
  provider?: string | null;
  tokens_total?: number | null;
  duration_ms?: number | null;
  observed_at?: string;
  verification?: string;
  pr_linkage?: string;
  url: string;
}

export interface PublicIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  updated_at: string;
  observed_agent_runs_7d?: number | null;
  pr_references?: IssueReferences;
  agent_runs?: IssueRun[];
}

export interface WorkflowRunEvidence {
  run_id: number;
  attempt: number;
  status: string;
  url: string;
}

export interface PullWorkflow {
  head_sha?: string | null;
  ci?: WorkflowRunEvidence | null;
  e2e?: WorkflowRunEvidence | null;
}

export interface ReviewEvent {
  review_id: number;
  commit_sha: string;
  state: string;
  submitted_at?: string;
  url: string;
}

export interface PullReview {
  status?: string;
  latest?: ReviewEvent | null;
}

export interface PublicPull {
  number: number;
  title: string;
  state: string;
  url: string;
  updated_at: string;
  workflow?: PullWorkflow;
  review?: PullReview;
}

export interface LineageEdge {
  issue: number;
  pr_number: number;
  pr_head_sha: string;
  role: string;
  agent_id: string;
  run_id: number;
  attempt: number;
  source_url: string;
  source_ref_sha: string;
  slice_id?: number | null;
  verification?: string;
}

export interface Lineage {
  status?: string;
  source_ref_sha?: string;
  truncated?: boolean;
  edges?: LineageEdge[];
}

export interface AgentResultRecord {
  issue: number;
  role: string;
  agent_id: string;
  run_id: number;
  attempt: number;
  source_url: string;
}

export interface AgentResultObservations {
  status?: string;
  truncated?: boolean;
  records?: AgentResultRecord[];
}

export interface AcceptanceRecord {
  issue?: number;
  id: string;
  result: string;
  run_id: number;
  attempt: number;
  target_sha: string;
  url: string;
}

export interface AcceptanceE2E {
  status?: string;
  source_sha?: string | null;
  records?: AcceptanceRecord[];
}

export interface AgentStoreReadiness {
  status?: string;
  sha?: string | null;
  url?: string | null;
}

export interface WorkSection {
  issues_status?: string;
  pulls_status?: string;
  workflow_runs_status?: string;
  issues?: PublicIssue[];
  pulls?: PublicPull[];
  agent_run_source?: string;
  lineage?: Lineage;
  agent_result_observations?: AgentResultObservations;
  acceptance_e2e?: AcceptanceE2E;
  agent_store_readiness?: AgentStoreReadiness;
}

export interface EvidenceStore {
  name: string;
  purpose: string;
  state: string;
  sha: string;
  url: string;
  updated_at?: string | null;
  freshness?: Freshness;
  records?: number | null;
  truncated?: boolean;
}

export interface EvidenceSection {
  stores?: EvidenceStore[];
}

export interface SiteSnapshot {
  schema_version?: number;
  generated_at?: string;
  source?: SourceInfo;
  repository?: RepositorySection;
  agents?: AgentsSection;
  work?: WorkSection;
  evidence?: EvidenceSection;
}
