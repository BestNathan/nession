# Files Workspace prototype record (#2751)

This is the durable record of the interactive Files prototype that explored
source-aware creation, read-first editing and conflict recovery. The mock lives
on the shared orphan `prototype` branch, not in the product checkout; this page
records what it demonstrates, where its immutable source is, and what it does
not prove.

## Preview and immutable source

- Preview (HTTPS, verified live 2026-11-05):
  <https://bestnathan.github.io/nession/prototypes/files-workspace-2751/index.html>
- Source revision (shared orphan `prototype` branch, not part of the product
  checkout):
  [`98fdde35f021b59739c46e2da71f565c27ecf7cc/files-workspace-2751`](https://github.com/BestNathan/nession/tree/98fdde35f021b59739c46e2da71f565c27ecf7cc/files-workspace-2751)
- The Pages `prototypes/manifest.json` was verified on 2026-11-05 to report
  source SHA `98fdde35f021b59739c46e2da71f565c27ecf7cc` and the
  `files-workspace-2751` entry. The first committed prototype revision was
  `3c5ba4cbb19d2baf254564c519b5c6392d88fd29`; the HTML and README blobs at the
  published head are byte-identical to that revision, so the preview shows the
  same mock.

## Question settled

Does selecting a directory or file resolve one frozen create destination
without conflating browse, selection and expansion; do the Web tree and App
navigator express the same operation contract; and can a user identify the
source and recover from a duplicate name, a dirty edit or an external change
without losing their work?

## Scenario the mock demonstrates

1. Web: select `src/components`, New file, see that destination, create
   `Button.tsx`, and reveal it under the selected directory.
2. Web: select `src/App.tsx`, then New folder — the destination is `src/`, not
   the file path.
3. Web: a folder's context action names and uses that folder even when another
   row is selected; expansion and selection are independent.
4. Web: a duplicate name is rejected with the form, name and destination
   preserved; an invalid name is refused before any mutation.
5. Web: a read-first file opens, Edit makes it dirty, leaving prompts to keep
   editing or discard, and an external update turns Save into an explicit
   reload/overwrite conflict choice.
6. Web: switching source changes the tree; an offline source renders
   unavailable rather than showing host data as a fallback.
7. App: push `src` then `components`, use Add → New file in the pushed
   directory, view the file read-first, Edit explicitly, and get the unsaved
   guard on Back.

## Verified browser pass

The live preview was driven at 1440×900 in Chromium on 2026-11-05:

- the page loaded from the published Pages URL (HTTP 200) with no console
  errors or page errors;
- selecting `src/components` and choosing + File showed `src/components/` as
  the captured destination; typing `Button.tsx` and creating added it under
  that directory;
- repeating the create with the same name was refused and the typed name stayed
  in the form.

The Issue also records the prototype author's static V8 parse and six
in-memory DOM interaction checks (initial, selected-directory destination,
created/revealed, duplicate rejection, remote-version conflict, mobile
pushed-directory creation). The conflict and offline simulations remain
mock-only; they were not independently re-driven in the browser pass above.

## Fidelity and limitations

- **Mock**: files, source identities, revisions, latency, conflicts, creation,
  saving, upload and availability are deterministic mock data and local browser
  state.
- **Not proven by the mock**: real P2P/Relay, Agent RPC, Session authorization,
  `SandboxPolicy`, OS filesystem, provider write integration, real upload or
  backend conflict detection. The sandbox label is a selected mock source, not
  evidence that a Session's mount namespace is readable or isolated.
- **Mobile real-browser check: not verified**; the App scenario is simulated in
  the same page (CSS responds to narrow viewports) rather than on a physical
  device.
- The mock is not an Acceptance receipt and must not be cited as production
  browser evidence. Production proof for create-only, no-replace rename and
  stale-revision conflict belongs to the #2751 Acceptance Cases (SC-01–SC-06)
  and the source-aligned staging Case SC-04, not to this artifact.

## Synchronization

The product design owner is
[file-workspace.md](file-workspace.md#file-identity-and-the-source-boundary-2751).
The prototype's Web tree/edit flows and App pushed-directory flow were kept
aligned with that owner's identity, operation-context, safe-mutation and
byte-boundary sections. Sandbox policy and enforcement remain #2681's; this
prototype and the Files capability consume an explicit source and do not claim
isolation.
