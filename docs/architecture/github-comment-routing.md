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
| `/develop dev-qwen-01` | open, unclaimed native Bug Issue | current Bug → trusted Controller → agent-store → Qwen Developer | **BestNathan OWNER only**, exact unedited comment, no in-progress status or linked open PR |
| `/case SC-NN` | open native Requirement/Bug Issue | trusted associated merged SHA → Acceptance / Cases | OWNER/MEMBER/COLLABORATOR; Case-method SC only |
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

For `/case SC-NN`, the router reads the Issue's `Acceptance Plan` and selects
only an explicit `when: merged, branch: staging|main, method: case` SC.
It searches a **bounded** GitHub merged-PR inventory for an Issue-associated
merge commit on that branch, verifies the commit is still the exact branch
head or its GitHub-authenticated ancestor, and loads the Case manifest
from the **exact merge commit**. The manifest controls the existing fixed
runtime and OS platform (Linux by default; macOS-only selects macOS).
Comment text cannot supply SHA, ref, stage, runtime, platform or environment.
Absent Case, unavailable merged provenance, missing GitHub API access,
unsupported PR/deployed stage or truncated inventory are errors—not Case Pass.
For `platform: both`, one request exercises the Linux half only; the
existing dual-native Case combiner withholds unpaired success. A separate
native platform execution must supply the paired evidence.

The routed `Acceptance / Cases` workflow carries `source_comment_id` and
uses a comment-bound Run name. On the chosen platform **before target checkout**,
trusted Main independently reads the original GitHub human comment/Issue,
rejects edits, untrusted actors, unsupported or stale targets, and recomputes
the bound merge SHA/Case manifest. Ordinary direct Actions/UI/manual and
automatic push Case triggers remain supported with no comment ID.
This preserves the separate authenticated GitHub Run/Attempt/Job/Step binding
for manual Staging (#3316), existing Case selection, immutable Case ingest,
Run Store and Issue projector. A successful command receipt **is not** proof
of any SC: only ingested evidence for an eligible open Issue may project Pass.
A completed/closed Issue is not silently reopened just to replay a Case.

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

## Bug Developer from an Owner comment (#3488)

The first production command is **`/develop dev-qwen-01`**, posted as a
single unedited line under the Bug Issue itself. It is intentionally not
`/develop #1234`: Issue identity comes from the GitHub comment, not free text.
It supports the already registered Qwen Developer only. For example, post it
under #3433 if that Bug is still open and unclaimed; do **not** post it under
an already progressing #3444/#3451 PR.

GitHub deliberately suppresses the `workflow_run` cascade for a
`workflow_dispatch` initiated with `GITHUB_TOKEN`. After dispatching the
unprivileged Controller, the Router therefore re-reads its exact authenticated
Run/Attempt from GitHub, requires **completed success**, and performs one
explicit `workflow_dispatch` to `Store / Agent Controller Ingest` with only
`source_run_id`. That Store workflow accepts the bot-only main request,
re-fetches the real Controller Run/Artifact and revalidates the original human
comment *before* minting the scoped Store App token. A Router receipt still
does not assert Store creation or Worker execution. Duplicate wakes are detected
by their exact source-bound Run name; the Store CAS root is never reset.

The existing Comment Router confirms owner identity and the original open Bug
Issue via REST; it refuses edited comments, arbitrary providers, existing
`status:in-progress` and related open implementation PRs. It dispatches
**only an unprivileged Controller request** with the Issue number and original
comment ID. The Controller pins the trusted `main` SHA, resolves the registered
roles, and emits a uniquely attested request Artifact. The independent
`Store / Agent Controller Ingest` re-authenticates the original comment,
actual Run/Attempt/Artifact and GitHub SHA before Store App issuance. It commits
one immutable Controller root on `agent-store`, marks the Bug in progress, and
uses the existing Store CAS/write-ahead/HMAC-ticket machinery to dispatch one
`Agent / Development` Qwen Worker. It never gives the Worker its GitHub writer,
Store secret, signing key or publisher token.

The Worker edits only bounded tracked source with Read/Edit/Write, and emits
an untrusted patch and encrypted native Session; the separate Publisher,
Reviewer, Quality and Acceptance keep their independent responsibilities.
Repeated comments never reset an existing Controller state, and a 204/timeout
does not justify blindly dispatching a second Worker. A router acknowledgment
means *request accepted*, not *Worker started*, *PR published* or *SC Pass*.

For a rejected command, first inspect the original Issue type/status, existing
PRs, edited comment/author permissions and the router/Controller Run. A failed
source verification does not trigger a model. Existing historical #1997/#3001
recovery commands stay pinned and separate. The command is active only after
the main-owned workflow and script changes have merged and their authenticated
Run/Store readback has been checked.

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
