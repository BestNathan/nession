# GitHub Issue/PR comment commands (#3268)

## Authority and intent

Comments request work; they are never a test result, merge approval, published
artifact, SC verdict, or permission to execute arbitrary code. Nession's
main-owned **Automation / Comment Router** owns the ordinary human command
intake. Domain workflows remain the sole owners of execution, telemetry,
admission, Gate results, provenance, and independent Acceptance projection.

| Comment | Surface | Target / handler | Authorization |
| --- | --- | --- | --- |
| `/audit` | open native Issue | current Issue → Agent / Issue Audit (single) | OWNER/MEMBER/COLLABORATOR |
| `/audit tree` | open native Issue | current Issue → Agent / Issue Audit (tree) | same |
| `/accept` | open native Issue | current Issue → Acceptance / Manual Request | same; recovery request only |
| `/e2e full` | open same-repository PR | exact current PR HEAD SHA + branch → E2E / Full Regression | repo owner or collaborator with write+ |

Other slash strings are not commands. In particular, `/e2e` is **not** an
alias to dispatch main-branch E2E, and `/review` cannot bypass its existing
Outbox/Admission action identity. Fork PRs have no approved exact-ref executor
and are rejected. Repo-wide Store/Metrics/Deploy remain in their own operational
entrypoints.

## Source authentication and context

1. Only newly created top-level Issue/PR conversation comments are accepted,
   not review-thread comments, edited commands, bots or injected multiline text.
2. The router independently fetches the original comment and current Issue;
   for PRs it also fetches the canonical PR, including both base/head SHAs and
   the head repo. It rejects content/author drift between the signed webhook
   and live GitHub. Privileged PR Full E2E requests check repository permission.
3. Context is a fixed command property; Issue commands cannot target PRs and
   PR commands cannot target Issues. The PR target is the exact SHA observed
   during the command, never `github.sha` (the default-branch event SHA).
4. Before dispatch the router repeats the source and target resolution; any
   change since planning fails closed. The Full E2E workflow itself checks
   that the exact SHA is reachable from the named repository branch.
5. All workflow code is checked out from trusted `main`; the PR branch is
   an explicitly selected, isolated test target, never a privileged script source.

## Execution and evidence

The router sends only allowlisted workflows and fixed, typed inputs to
`workflow_dispatch` on `main`. For Issue commands, the downstream job
re-reads `issues/comments/{id}` and `issues/{number}` using GitHub REST,
materializes a synthetic original `issue_comment` event, then invokes the
**existing** audit parser or lifecycle reconciler. That preserves human
author/association checks despite the new bot dispatch actor.

The Audit Run remains **Agent / Issue Audit**; it is not replaced by a
reusable workflow with a different Source Run identity. Acceptance remains
**Acceptance / Manual Request**, which can only reconcile or request
already-qualified SC work, never write a Pass directly.

The optional Full Regression comment inputs affect its Run title, not the
Convergence Full identity used for automatic release qualification. Its
exact-source verifier, immutable evidence rules and original automatic
triggers remain intact. A comment-triggered Full success does not itself
authorize merge, SC Pass, release, or production deployment.

Stable request identity is `github:comment:<id>`. Router concurrency serializes
duplicate deliveries of that comment. Before dispatch the router checks for
an existing domain Run with the exact comment-bound Run name and for a bot
acknowledgment marker. Bounded inventories fail closed if truncated rather
than guessing. An acknowledged command is not an Acceptance verdict. A
GitHub workflow run may not be visible immediately after a 204 dispatch; in
that case the bot acknowledgment points to the workflow page rather than
inventing a Run ID. Any dispatch/receipt uncertainty must be reconciled
against the authoritative GitHub source records.

## Migration boundaries

The direct `issue_comment` subscriptions have been removed from
`agent-issue-audit.yml` and `acceptance-manual-request.yml`.
Automatic Issue edit/open/reopen Audit triggers remain unchanged. Other
specialized subscribers (e.g., Staging Convergence owner commands,
Knowledge publisher signals, and pinned historical Store recovery) are
intentionally **not** absorbed into the generic parser; changing their
authority or Source Run identity requires an independent migration with
exact event/Run/Artifact/Gate parity.

The thin workflow and stable script contract are checked by the existing
`workflow-conventions` Gate. Changes to a command's context or privilege
require positive/negative fixtures and a fresh GitHub Run/Job/Step review.
