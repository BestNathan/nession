// Public-safe local development fixtures. No tokens, Rust, server or private
// snapshots are required to run the Pages UI locally.
const sha = 'a'.repeat(40);
const metrics = 'b'.repeat(40);
const generated = '2026-11-24T00:00:00Z';

export const devFixtures: Record<string, unknown> = {
  '/data/site.json': {
    schema_version: 1,
    generated_at: generated,
    source: {repository: 'BestNathan/nession', main_sha: sha, metrics_sha: metrics, acceptance_results_sha: null},
    repository: {
      available: true,
      sha,
      generated_at: generated,
      freshness: {state: 'fresh', age_hours: 0},
      current: {loc: 120000, files: 900, tests: 1200, rust_coverage: 0.8, web_coverage: 0.75, protocol_units: 40, unit_pass: 1},
      efficiency: {commits_7d: null, additions_7d: null, deletions_7d: null, merged_7d: null, open_issues: null, open_prs: null},
    },
    agents: {
      available: false,
      generated_at: null,
      freshness: {state: 'unavailable', age_hours: null},
      summary: {},
      roster: [],
      outcomes: {},
      distribution: {},
    },
    work: {
      issues_status: 'unavailable',
      pulls_status: 'unavailable',
      issues: [],
      pulls: [],
      workflow_runs_status: 'unavailable',
      agent_run_source: 'unavailable',
      lineage: {status: 'unavailable', edges: [], truncated: false},
      agent_result_observations: {status: 'unavailable', records: [], truncated: false},
      acceptance_e2e: {status: 'unavailable', source_sha: null, records: []},
      agent_store_readiness: {status: 'unavailable', sha: null, url: null},
    },
    evidence: {stores: []},
  },
  '/data/knowledge.json': {
    schema_version: 1,
    status: 'available',
    source: {branch: 'knowledge', sha: metrics, generated_at: generated},
    topics: ['engineering'],
    categories: ['local-development'],
    articles: [
      {
        path: 'topics/engineering/local-development.md',
        title: 'Local development',
        description: 'Public-safe fixtures let the standalone Pages UI run without trusted data.',
        topic: 'engineering',
        categories: ['local-development'],
        status: 'verified',
        updated_at: generated,
        sources: ['https://github.com/BestNathan/nession/issues/4448'],
        body: '## Fixtures\n\nThese local fixtures are not published templates.',
      },
    ],
    changes: [],
  },
  '/data/documents.json': {
    schema_version: 4,
    status: 'available',
    generated_at: generated,
    source: {repository: 'BestNathan/nession', branch: 'main', sha, source_version: '0.0.0-dev'},
    definitions: {},
    releases: [],
    protocols: [
      {
        id: 'dev.status',
        owner: 'dev',
        wires: ['dev.status'],
        versions: [
          {
            version: 1,
            request: {
              alias: 'DevStatusRequest',
              shape: {type: 'object', properties: {}},
              fields: [],
            },
            response: {
              alias: 'DevStatusResponse',
              shape: {type: 'object', properties: {ok: {type: 'boolean'}}},
              fields: [
                {
                  path: 'ok',
                  type: 'boolean',
                  required: true,
                  description: 'Local fixture only',
                  since: null,
                  since_status: 'unknown',
                },
              ],
            },
          },
        ],
      },
    ],
  },
  '/data/mcp.json': {
    schema_version: 2,
    status: 'available',
    semantic_sha256: 'c'.repeat(64),
    protocol_versions: ['2025-03-26'],
    source: {repository: 'BestNathan/nession', branch: 'main', sha},
    upstream: {
      stable: {
        version: '2025-03-26',
        sha: metrics,
        changelog_blob_sha: 'd'.repeat(40),
        changelog_sha256: 'e'.repeat(64),
        release_url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2025-03-26',
        source_url:
          'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/' +
          metrics +
          '/docs/specification/2025-03-26/changelog.mdx',
        previous_version: null,
        highlights: [],
      },
    },
    tools: [
      {
        name: 'nession_dev_status',
        description: 'Local fixture Tool.',
        inputSchema: {type: 'object', properties: {}},
        outputSchema: {type: 'object', properties: {ok: {type: 'boolean', description: 'Local fixture'}}},
      },
    ],
  },
  '/data/workflows.json': {
    schema_version: 1,
    source: {repository: 'BestNathan/nession', main_sha: sha, generated_at: generated},
    groups: [
      {id: 'intake', label: '01 / Intake', detail: 'Local fixture'},
      {id: 'agent', label: '02 / Agent', detail: 'Local fixture'},
      {id: 'quality', label: '03 / Quality', detail: 'Local fixture'},
      {id: 'acceptance', label: '04 / Acceptance', detail: 'Local fixture'},
      {id: 'evidence', label: '05 / Evidence', detail: 'Local fixture'},
      {id: 'delivery', label: '06 / Delivery', detail: 'Local fixture'},
    ],
    nodes: [
      {
        id: 'ci-quality',
        name: 'CI / Quality Gate',
        group: 'quality',
        description: 'Local fixture workflow definition.',
        triggers: ['pull_request'],
        url: 'https://github.com/BestNathan/nession/blob/' + sha + '/.github/workflows/ci-quality.yml',
      },
    ],
    edges: [],
  },
  '/prototypes/manifest.json': {
    schema_version: 1,
    source: {branch: 'prototype', sha: metrics},
    entries: [],
  },
};
