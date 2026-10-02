# Gate checks

Concrete Gates live here: `<gate-id> -> gates/checks/<gate-id>.sh`.

The filename stem and declared `GATE_ID` must match exactly. Independently routable checks with different failure/repair semantics use different IDs.

Use `../run --list`, `../run --describe <id>`, and `../run --validate`. Routing and suite composition do not belong here.
