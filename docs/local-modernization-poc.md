# Local modernization PoC — Chopin work

Status: local runtime implemented; human acceptance pending, November 24, 2026. Branch `codex/local-modernization-poc` starts from `origin/dev` at `49aebb3f0807532a6df741d6207d2b1da091f9c1`.

[Canonical plan and cross-repository tracker](https://github.com/joefeser/who-decides/issues/41).

The owner now requests a local-only profile with local identities, local checkout access, SQLite persistence, and a decision bridge that works with outbound networking blocked. This supersedes the earlier bridge-only exclusion of Chopin identity changes for this experiment. The local runtime and synthetic restart proof are implemented on this branch.

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

## Local runtime

Use the companion Who-Decides [setup/runbook](https://github.com/joefeser/who-decides/blob/codex/local-modernization-poc/docs/private-local-setup.md) for the foreground supervisor and reproducible HTTP proof. The files are currently on the implementation branches; no merge or migration is implied.

`AUTH_MODE=offline` requires literal loopback binding, `STORAGE_DRIVER=sqlite`, a durable `SQLITE_PATH`, `SESSION_ENCRYPTION_KEY`, a 0600 `CHOPIN_OFFLINE_DIRECTORY` JSON file, `AGENT=off`, and `BACKGROUND_JOBS=off`. Hosted models, transcription, and automatic builds/spikes are disabled. Human credentials issue signed 12-hour access tokens stored encrypted in the existing durable session store. Machine secrets are independently hashed and cannot use the human sign-in route. Grants identify configured `local/name` workspaces; there is no GitHub identity or App installation.

The existing GitHub-shaped internal provider port is adapted locally to keep upstream integrations small. The offline adapter performs no network requests and refuses GitHub token exchange/refresh. It does not emulate GitHub authorization. Hosted-only UI links may be unavailable; connector provisioning and remote Planner execution are not part of this proof.

SQLite uses `BEGIN IMMEDIATE`, WAL, FULL synchronous commits, a 64 MiB checkpoint ceiling, and format/runtime validation. It serializes the explicit contract engine state (including Maps, Dates, bytes and shared references) with Bun's V8 codec; callbacks, queues, and live rooms are not persisted. All asynchronous port operations reload committed state and commit before acknowledging; lease peeks are read-only. Synchronous AI revocation counters expose the last committed engine. Memory remains unavailable as a runtime fallback. This is a small-workspace PoC, with no large-site performance or cross-Bun-version migration claim. Changing persisted engine fields requires a checkpoint-format migration, even when a future upstream memory test still passes.

`POST /api/offline/decisions` is available only in offline mode. An authenticated writer can request one card via the normal domain service using a ULID request ID and identified choices. Replays return the same card; conflicting payloads refuse. It cannot submit an answer. Settlement still uses `answer_decision` and the existing revision/idempotency checks. Machine attribution remains the machine's name.

Offline visual admission checks syntax and explicit diagrams without inferring model-selected visual requirements. It is intentionally different from hosted editorial assessment; hosted behavior is unchanged.

The real HTTP proof passed local sign-in, private evidence reads, workspace denial, idempotent requests, stale refusal, pending-decision restart, SIGKILL after settlement with a lost response, exact retry with one settlement, worker restart, and stopped backup/restore. Both apps ran with OS-denied external networking. The synthetic operator is not human sign-off; migration remains deferred. Keep keys and credential files with private backups, and stop both apps before copying SQLite files.
