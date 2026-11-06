# Nession Product

Nession is a continuous, intelligent workspace for work across devices, environments, and compute nodes.

This document is the **index of Nession product generations**. Each major version line has a product definition describing the experience it aims to deliver, its user value, scope, and boundaries. A product generation is not a release checklist or a promise that every proposed feature ships in its first minor release.

## Product generations

| Generation | Positioning | Status | Product goal |
| --- | --- | --- | --- |
| [0.x](docs/product/0.x.md) | **Remote Control** | Existing 0.x product line | Reach remote nodes and control persistent terminal sessions from different devices. |
| [1.x](docs/product/1.x.md) | **Session & Workspace** | **In development**; target, not a released product claim | Make Session the way users return to work and Workspace the coherent context for resources and capabilities around that work. |
| 2.x and later | **Not defined** | Future | Defined only when a distinct user problem, experience, and product boundary are agreed upon. |

The repository can continue shipping 0.x releases while designing and building 1.x. A product-generation definition does **not** imply that the matching release already exists, nor does it fix a release date.

## What a product definition owns

A generation definition answers:

1. **Who and why:** the primary users, situations, and problem.
2. **User experience:** what users should be able to accomplish without understanding implementation topology.
3. **Product model:** the key concepts and relationships at that generation, linking to canonical design documents for precise semantics.
4. **Scope and non-goals:** the capabilities and constraints that make the generation meaningfully different from its predecessor.
5. **Readiness:** observable product outcomes that characterize the target; detailed acceptance and delivery evidence remain with Requirements and release processes.

A new major generation should be proposed because the product's *value proposition or user mental model* changes, not merely because more features have accumulated. Minor/patch releases evolve an existing generation and are tracked separately by issues, PRs, and releases.

## Authority and reading order

- [VISION.md](VISION.md) owns the enduring direction: **why Nession exists and what it aims to become**.
- [PRINCIPLE.md](PRINCIPLE.md) owns cross-generation product decision constraints: **how Nession should grow**.
- This index and the linked **generation definitions** own the product target for each major line: **what experience the generation promises**.
- [docs/design/README.md](docs/design/README.md), especially [product-model.md](docs/design/product-model.md), own current detailed product semantics, information architecture, and interaction rules: **how the target is modeled**.
- GitHub Requirements, implementation plans, code, and release notes own **what is built, verified, and shipped**.

Generation documents must be consistent with Vision and Principles. Do not turn them into feature inventories, implementation architecture, version changelogs, or speculative roadmaps. Where the product target and current implementation differ, identify that difference explicitly instead of treating a design objective as a shipped capability.

## Evolution

Keep each generation document as the canonical statement of that generation's product intent. While a generation is in development, refine its scope deliberately as product decisions are made. When it is superseded, retain it as the historical product contract; capture a changed positioning in a new generation instead of silently rewriting the earlier goal.

Do not assign 2.x/3.x positioning prematurely. Future concepts such as autonomous workflows or deeper AI assistance are possibilities under the Vision, not version commitments until separately decided.
