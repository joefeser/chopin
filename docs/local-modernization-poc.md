# Local modernization PoC — Chopin work

Status: planned, November 24, 2026. Branch `codex/local-modernization-poc` starts from `origin/dev` at `49aebb3f0807532a6df741d6207d2b1da091f9c1`.

[Canonical plan and cross-repository tracker](https://github.com/joefeser/who-decides/issues/41).

The owner now requests a local-only profile with local identities, local checkout access, SQLite persistence, and a decision bridge that works with outbound networking blocked. This supersedes the earlier bridge-only exclusion of Chopin identity changes for this experiment. Implementation is pending.

## Tasks

- [ ] [Local identity, workspace permissions, and machine authentication](https://github.com/joefeser/chopin/issues/1)
- [ ] [SQLite adapter and recovery contract](https://github.com/joefeser/chopin/issues/2)
- [ ] Participate in [end-to-end offline proof](https://github.com/joefeser/who-decides/issues/43).

## Current behavior and changes to verify

The current [authentication documentation](authentication.md) describes `AUTH_MODE=local` as GitHub device login. Introduce an explicitly named offline profile and inventory GitHub dependencies in startup, browser/WebSocket authorization, MCP, local-checkout identity, machine pairing, and implementation publication.

The current [storage contract](storage.md) supports PostgreSQL at runtime. Add SQLite through the storage interface and verify atomic commits, revision conflicts, operation replay, writer exclusion, and restart recovery with actual database files. Update runtime claims when the implementation lands.

Use separate human and machine principals and local workspace permissions. Retain existing GitHub and PostgreSQL coverage. Small isolated changes and explicit adapter contracts should keep upstream integration manageable.

First prove local sign-in, document/card creation, exact decision settlement, restart continuation, stale-answer rejection, lost-response recovery, private reads, and backup/restore. Use a model-free worker and pre-staged dependencies. Human acceptance and fixture tests have separate receipts.

The original C3 record's location remains unresolved. Add a scoped supersession link once located, preserving its historical context. This plan supplies the new direction without rewriting old receipts.
