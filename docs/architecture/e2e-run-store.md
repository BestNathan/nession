# E2E Run Record evidence retention and digest scopes

## Trusted storage

Nession maintains **one append-only orphan branch**, `acceptance-results`, for compact trusted Case and Scenario records. The source code and Scenario/Case manifests remain in the product Git history. Only the **main-controlled** ingestion workflows can create results or update Issue/SC Acceptance Reports.

The source workflow is always checked against its GitHub-owned identity: repository, workflow path and ID, SHA, branch, event, run ID and attempt; the trusted ingest fetches the actual source Git tree before appending. A checksum of attacker-supplied JSON alone is never an attestation of its producer.

## Finite artifact retention contract

| Mode | Compact immutable record | External source artifact | Retention |
| --- | --- | --- | --- |
| Acceptance Case | `runs/YYYY-MM-DD/RUN-ATTEMPT/ISSUE/SC.json` | `acceptance-case-results-RUN-ATTEMPT` | 90 days |
| Terminal Scenario | `runs/YYYY-MM-DD/RUN-ATTEMPT/scenario/NAME-INDEX.json` | `e2e-terminal-scenario-RUN-ATTEMPT` | 14 days |

The trusted receipt `evidence` attached to newly ingested records declares **schema_version=1, mode, provider, artifact_name, sha256, digest_scope, retention_days, retrieval_url and durability**. The scope of `sha256` is **validated-source-record-json**, which is the canonical source record fed into the ingestor; it **is not the binary digest of the GitHub artifact ZIP**. The immutable record and its validated checksum remain in the orphan history even after the source artifact expires, subject to repository retention/access policy. Raw browser traces, screenshots, video and full terminal output are **not archived permanently** by this design.

The bounded receipt generator verifies run ID/attempt, full 64-character source record SHA-256, and a GitHub Actions URL belonging to the same authenticated run. Modes have fixed artifact prefixes and retention days. A changed digest, URL, attempt, retention or unexpected envelope field is rejected. Legacy records without the new evidence envelope remain readable; they do not gain retroactive retrieval promises.

## Limits and negative cases

- A GitHub Actions success status or GitOps branch push is **not** proof that an actual VPN-connected deployment was ready.
- A time-limited Actions artifact can expire; its `retrieval_url` is a locator rather than evidence that bytes still exist.
- The Scenario `evaluation=null` is an observation. No Scenario collection step may generate a fabricated Acceptance Pass.
- A Case `Pass` requires its own trusted Issue/SC contract, exact source SHA and verifier evidence, followed by the deterministic updater.
- Missing eligible Case coverage must fail closed; a stage with no eligible SCs is separately classified `not-applicable`, never a Case Pass.
- Collision/replay/idempotency behavior is independently gated by the trusted orphan ingestion fixtures. Do not replace a record on divergent bytes.
- Long-term large artifact archival requires a **separately approved object storage policy**, object checksum, access controls, expiry and deletion audit; it is *not implemented* by this receipt contract.

The executable contract is `scripts/run-record-artifact-evidence.mjs`, self-tested by the mandatory Quality Gate and used by the two main-owned ingestion programs. The source workflow retention durations must remain synchronized with these exact contract values.
