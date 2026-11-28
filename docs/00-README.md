# OpenCanvas documentation index

| # | Document | What it answers |
|---|---|---|
| 01 | [Research & competitive analysis](01-RESEARCH-COMPETITIVE-ANALYSIS.md) | How Slack Canvas, Zoom Canvas, Microsoft Loop work; Collabora's integration model; CRDT choice |
| 02 | [PRD](02-PRD.md) | What we build, for whom, scope, NFRs, success metrics |
| 03 | [HLD architecture](03-HLD-ARCHITECTURE.md) | Components, flows, persistence, scaling, deployment shape |
| 04 | [Technical design](04-TECHNICAL-DESIGN.md) | Block schema, Yjs layout, `.ocanvas`, WS protocol, DB schema, REST, config, tests |
| 05 | [Integration guide](05-INTEGRATION-GUIDE.md) | The host contract: JWT/WOPI, embed, callbacks, postMessage, REST |
| 06 | [Collaboration & presence](06-COLLABORATION-AND-PRESENCE.md) | Merge semantics, cursors, undo, connectivity, comments |
| 07 | [Security & limits](07-SECURITY-AND-LIMITS.md) | Threat model, controls, limits, privacy |
| 08 | [ADR register](08-ADR-REGISTER.md) | Decisions and their status |
| 09 | [Roadmap](09-ROADMAP.md) | Phases and exit gates |
| 10 | [Execution tracker](10-EXECUTION-TRACKER.md) | Every work item and its status |
| 11 | [Design-first process](11-DESIGN-FIRST-PROCESS.md) | How work flows; the UI approval gate |
| 12 | [Glossary](12-GLOSSARY.md) | Terms |
| 13 | [Operations & deployment](13-OPERATIONS-AND-DEPLOYMENT.md) | Running it: single node, cluster, AI and MCP configuration, metrics |
| 15 | [Build contract](15-BUILD-CONTRACT.md) | Exact server ↔ web ↔ host interfaces for the P1 build |
| 21 | [Users and identity](21-USERS-AND-IDENTITY.md) | How hosts provide people, duplicate names, mentions that stay correct |
| 22 | [Capacity and sizing](22-CAPACITY-AND-SIZING.md) | Load benchmark (`scripts/bench.sh`), measured limits, sizing table for self-hosters |
| 24 | [AI, agents and MCP](24-AI-AND-MCP.md) | The assistant (plan, approve, act, review, undo), the MCP endpoint, model providers (Claude Platform or a self-hosted OpenAI-compatible server), safety and limits |
| 25 | [Release v0.1.0-alpha.1](25-RELEASE-v0.1.0-alpha.1.md) | The first alpha: evidence, limitations, backup and recovery |
| 26 | [v0.1.0 scope lock](26-RELEASE-v0.1.0-SCOPE.md) | What v0.1.0 froze, exit criteria, change control |
| 27 | [v0.2 plan](27-ROADMAP-v0.2.md) | Headless API, block SDK, live blocks design; ADRs 039–042 |
| 28 | [Release v0.1.0](28-RELEASE-v0.1.0.md) | Changes since the alpha, upgrade notes, known limitations |
| 29 | [Diagramming](29-DIAGRAMMING.md) | Board formats, interaction, compatibility, and performance |
| 30 | [Version history](30-VERSION-HISTORY.md) | Host capabilities, comparing versions, restore, and undo |
| 31 | [Release notes v0.1.2](31-RELEASE-v0.1.2.md) | Changes, upgrade guidance, and limitations |
| 32 | [Release v0.2.0](32-RELEASE-v0.2.0.md) | Scope lock, upgrade notes (migrations 0008/0009, new `[host.*]` sections, 4426), known limitations, release checklist |
| 33 | [Block SDK guide](33-BLOCK-SDK.md) | Write, package and install a block |
| 34 | [v0.3 plan](34-ROADMAP-v0.3.md) | Live block deltas, offline-first editing, find and replace and cross-canvas search, automation rules; ADRs 063–069; delivery rows |
| 35 | [Release v0.3.0](35-RELEASE-v0.3.0.md) | What 0.3.0 contains, upgrade notes, known limitations |
| 36 | [v0.4 plan](36-ROADMAP-v0.4.md) | Partial sync, benchmarks, performance and maturity, spreadsheets and advanced databases; ADRs 076–079 |
| 37 | [Release v0.4.0](37-RELEASE-v0.4.0.md) | What 0.4.0 contains, upgrade notes, known limitations and what 0.4.1 closed |
| 38 | [v0.5 plan](38-ROADMAP-v0.5.md) | Plugins and a marketplace, backlinks, a knowledge graph, SDK extension points; ADRs 081–084 |
| 39 | [Dependency updates](39-DEPENDENCY-UPDATES.md) | How third-party code is taken in, updated and accounted for (DEP-01) |
| 40 | [OpenCanvas Workspace](40-WORKSPACE.md) | The first-party host: plan, owner decisions, ADR-085 |
