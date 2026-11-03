# Knowledge Explorer / standalone Pages (#2664)

**Owning Requirement:** https://github.com/BestNathan/nession/issues/2664
**Repository source:** `knowledge` orphan ref, pinned **fixture** SHA `1547d2c4207a4cd5407fcc05a1e45c6ff082f556`
**Artifact branch:** shared orphan `prototype` — this design mock does not belong to product main or Pages production code.

## Question and decision

How should the independent Pages observatory expose the public, source-backed Knowledge ledger without inventing a new article identity, write path, or authority model?

- Proposed production entry is the native `#/knowledge` route in Pages, not a new independent site.
- Desktop: topic/category rail, searchable current-article list, and source-evidenced reader.
- Narrow/mobile: list first; choosing an article enters its reading surface; explicit Back returns to the list.
- Distinct `Changes` view reflects **one global CHANGELOG**, not per-article revision objects.
- Articles are identified by actual topic/title-derived `path`, never a synthetic ID.
- `verified` is a sourced knowledge status, **not** an attestation of live product behavior.

## Primary mock walkthrough

1. Open `index.html`: on desktop, browse the three actual current article titles; on mobile, start on the list.
2. Search `terminal`, then choose topic `Terminal`, choose a category chip; matching article options update deterministically, with an honest empty result when there is no match.
3. Select **Web terminal emulator engine and component ownership**. Inspect its summary, topic, tags, sourced status, article update date, linked evidence, pinned original and history.
4. Follow **Related knowledge** to `Nession instruction architecture and knowledge ownership`; browser hash is updated. Browser Back/Forward can restore selection.
5. Switch to **Changes**; inspect global events and click **Read current article** or **Source Issue**.
6. Click **Simulate unavailable source**; the mock no longer claims an empty ledger or a current article. Restore or reset. On mobile, use Back to return to the article list.

## Data and behavior fidelity

- **Recorded public fixture:** three real Knowledge index article titles/descriptions/topics/tags/status/timestamps and selected source URLs at pinned `knowledge` SHA `1547d2c4...`, retrieved 2026-11-03. The mock's body paragraphs are **abbreviated representative excerpts** from public articles, not byte-for-byte Markdown.
- **Changelog:** five representative entries derived from public `CHANGELOG.md`, with shorter on-screen reasons; source links remain actual GitHub Issues. These are design fixtures, **not** a complete log or live history feed.
- **Mock-only:** search, client-side topic/tag filters, navigation, reading pane, change-log view, status outage switch and reset. No authenticated APIs, no Knowledge publishing, no live refresh, no runtime auth, no semantic search, no cross-repo fetch, no production acceptance.
- **Visual target:** standalone Nession Pages aesthetic (cream paper, forest-green text, editorial heading, quiet dividers). Not a product `web/` component/theme import. Remote Google Fonts are optional; fallback remains legible.
- **External links:** pinned original Knowledge article, original Git history and canonical public source URLs; they open actual external GitHub. The internal `#/knowledge` URL is **mock-owned**, not proof that Pages production route exists.

## Suggested production architecture

1. On trusted `main` Pages build, checkout `knowledge` read-only at a SHA; validate `index.json` and articles against `scripts/knowledge-ledger-contract.mjs`.
2. Compile a bounded snapshot such as `dist/data/knowledge.json` with `schema_version`, `source.branch`, `source.sha`, `generated_at`, topic/category index, safe article/Markdown structure and parsed global change log.
3. Render safely using DOM `textContent` and allowlisted HTTPS/internal links; never inject unsanitized HTML or execute Knowledge code.
4. Add `#/knowledge` native Pages view/navigation in `pages/app.js` and `pages/index.html`, with source/error/freshness distinctions; no duplicate articles in `main`.
5. Add static projection contract/negative fixtures and browser DOM tests. Verify the published JSON/HTML and exact pinned `knowledge` SHA with anonymous HTTPS digest readback after deployment.

**Non-goals:** edit/write UI, rich text CMS, embeddings/vector search, Knowledge branch rulesets (#2358), agent Knowledge Skill revisions, a standalone second page theme.

## Verification state

- File authored and published as a standalone static mock; controls are wired to deterministic client-side handlers.
- Static HTML/JS and branch readback to be checked as part of this handoff; do **not** claim actual desktop/mobile browser interaction or a Pages HTTPS publication receipt without those separate checks.
- Prototype proof **is not** production UI/E2E/Acceptance proof. Issue SC-01..SC-04 remain Pending.

## Open implementation choices

- Choose a small safe Markdown representation (build-time AST-to-allowlisted block JSON, or vetted renderer with strict sanitization), avoiding arbitrary raw HTML.
- Treat `candidate` distinctly from `verified`, and source-unavailable distinctly from zero search results.
- Preserve current history based on actual Git commits and the global log; do not silently invent per-article revisions.
