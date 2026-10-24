# Nession Knowledge

Current knowledge is organized primarily by **topic**, with **category tags** for secondary filtering.

- `topics/<topic>/<title-slug>.md` — one **current** article per complete title, Skill-style YAML frontmatter and readable Markdown
- `index.json` — generated `topics` and `categories` view; never hand-maintain
- `CHANGELOG.md` — single append-only knowledge-base-wide time and change index
- `schema/v2.json` — active contract

History is normal Git commit history. Former `entries/vNNNN`, `events/` and `receipts/` exist only in pre-migration commits, and **are not active knowledge artifacts**.

Governance and Skill: https://github.com/BestNathan/nession/blob/main/docs/engineering/knowledge-ledger.md and https://github.com/BestNathan/nession/blob/main/.claude/skills/nession-knowledge/SKILL.md.

Filename is the complete slug of `title`; there is no separate article `id`. See `CHANGELOG.md` for title renames and Git history for old content.
