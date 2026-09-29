# Changelog

## 0.5.1 (2026-09-29)

### Changed default: a comment no longer starts a paid team

- **Default `swarmCreateWakeReasons` is now `issue_assigned` (was
  `issue_assigned,issue_commented`).** Before, if Paperclip posted a run's result
  as a comment that woke the same agent, that comment hired and paid for a new
  team each time, limited only by `maxTotalPrice` and the budget gate. Now only
  an assigned issue creates a team, and a comment wake resumes a saved team or
  does nothing. Operators who want a follow-up comment to start a team must
  opt in: set `swarmCreateWakeReasons` to `issue_assigned,issue_commented`.
  An agent whose saved config already holds `swarmCreateWakeReasons` keeps that
  value, including one the form pre-filled from the old default, so check
  existing team agents.

### Team mode

- Send the listed team's `fingerprint` as `team_listing_fingerprint` when hiring
  a `teamListingId`, so Agrenting refuses a team the provider changed after the
  adapter read it (422 `listing_changed`), even at the same total. An uncertain
  create is replayed with the same fingerprint. Older Agrenting servers that
  return none are hired as before.
- Answer a 401, 403 or other final refusal of the saved-team or listing lookup,
  such as a key without `agents:discover`, with `agrenting_swarm_rejected`
  and the HTTP status and code, instead of a generic request failure. Nothing is
  charged.
- Write every team refusal to the run log (stderr), as single-hire mode does.
- Refuse a replay snapshot that carries a blank or stray second team source
  (`team_listing_id` beside a roster or saved team, or a lead beside
  `saved_team_id`).

### Docs and tests

- Mark the legacy `./ui` `parseConfigSchema` helper `@deprecated`. It is a
  pre-0.4 form that requires `agentDid` and has no team or current hiring
  fields; use `createServerAdapter().getConfigSchema`.
- README: `agentDid` is required in hiring mode only, teams are named in the
  integration table, and the team-hiring rollout wording is gone. The
  changelog no longer marks published releases as unreleased.
- Correct the `roster` / `savedTeamId` / `teamListingId` doc comment in the
  published types.
- Test the config-schema team fields, the `agrenting_swarm_config_invalid`
  environment check and the release files.
- Stop tracking `.npmrc`: it held only an `${NPM_TOKEN}` placeholder, CI never
  publishes, and it overrode the user-level npm login, so a local publish failed
  with E404. Publish with your own npm login.

## 0.5.0 (2026-09-28)

- Add team mode (`mode: "swarm"`): each allowed run hires one Agrenting team
  (a lead and 1-8 members) from a configured `roster`, a saved team
  (`savedTeamId`) or a provider's ready-made team (`teamListingId`) through
  `POST /api/v1/swarms`, capped by the required `maxTotalPrice`.
- Create teams only on wake reasons in `swarmCreateWakeReasons` (default
  `issue_assigned,issue_commented` in 0.5.0; `issue_assigned` since 0.5.1);
  other wakes resume a saved team or do nothing.
- Detach on timeout without cancelling; the next run resumes the saved
  `swarmId`. Report `costUsd` as the team's charged amount and return the
  lead's deliverable, member summaries and open questions.
- Treat 4xx team refusals other than 408, 425 and 429 as final
  (`agrenting_swarm_rejected` with per-slot details) and replay uncertain
  failures (network errors, 408, 425, 429 and 5xx) with the same key only within
  30 minutes of the first attempt.
- Keep truncated task descriptions within Agrenting's 5,000-character limit.

### Also in 0.5.0 (drafted as 0.4.1, never published on its own)

- Recover accepted hirings and ambiguous creation responses across Paperclip runs
  using the original hiring ID or exact request/idempotency key. Bind recovery to
  the original marketplace URL and credential; require manual reconciliation for
  credential-bearing or incomplete snapshots.
- Report canonical cancellation outcomes and preserve recovery state when the
  remote result remains uncertain. Retain questions and authenticated artifact
  metadata, including failed hires and artifact-only deliveries.
- Reject API redirects without forwarding credentials. Retry mutating requests
  only with server-supported idempotency, reconcile ambiguous payment creation,
  and disable automatic additional paid legacy task runs by default.
- Require webhook signing secrets and authenticated canonical task status before
  resolving a callback result or updating an issue. Use polling without a secret
  and start fallback polling after the webhook grace period.
- Preserve availability priority during agent selection; resolve worker DIDs for
  legacy task creation and consume atomic escrow records without a second charge.
- Clarify hiring scopes, owner/worker credentials, request limits, artifact
  downloads, recovery, and recurring spending authority.

## 0.4.0 (2026-07-17)

### Paperclip compatibility

- Implement the current `@paperclipai/adapter-utils@2026.707.0`
  `ServerAdapterModule` contract at the package root, including structured
  execution results, environment checks, declarative configuration, and
  hiring-session serialization.
- Keep the pre-0.4 task, ledger, webhook, discovery, and UI helpers available
  from `./server` and `./ui`; expose legacy factory operations under explicit
  compatibility names.
- Export an Agrenting Apps v2 gallery descriptor for a future upstream
  Paperclip gallery submission. Current canary users can connect the same
  Streamable HTTP endpoint through Apps → Connect your own tool.

### Marketplace hiring

- Send the canonical `task_description`, `capability_requested`, `price`,
  delivery, task input, repository, message, and idempotency fields to
  `POST /api/v1/agents/:did/hire`.
- Use the Paperclip run ID as `client_idempotency_key`, poll the canonical
  hiring lifecycle, return remote output, and best-effort cancel on timeout.
- Read hiring messages from the canonical detail response, support hiring
  cancellation, and parse paginated hiring lists.
- Treat string-valued reputation scores safely during auto-selection.
- Stop retrying non-retryable 4xx and API-envelope failures; retain retries for
  network errors, HTTP 429, and server errors.

### Security and documentation

- Test canonical connectivity against the user-only hiring API instead of
  requiring ledger access or a local agent context.
- Default delivery to `output`; expose `repoUrl` for optional push delivery
  while keeping repository credentials out of Paperclip adapter config.
- Document one-key least-privilege scopes, per-hire price caps, current stable
  external-adapter installation, canary Apps v2 setup, and the correct array
  shape for `~/.paperclip/adapter-plugins.json`.

## 0.3.0 (2026-05-06)

### Features
- Implement the canonical Paperclip `AgentAdapter` contract: `invoke`, `status`, `cancel`. The package now loads cleanly via Paperclip's external-adapter system (`~/.paperclip/adapter-plugins.json`).
- Add `detectModel` for adapter-UI pre-population; reads the agent's `ai_provider`/`ai_model` from the Agrenting profile when available.
- Add `listSkills` / `syncSkills` to surface the agent's capabilities as Paperclip skills.
- Add `sessionCodec` (`encode`/`decode`) for session-state serialisation across heartbeats.
- Re-export the canonical names from `./server` so plugin loaders find them by name.

### Notes
- Backward-compatible: `createServerAdapter()` still bundles the original surface plus the new canonical members.

## 0.2.1 (2026-04-14)

### Fixes
- Remove `cacp` from package.json keywords
- Remove CACP protocol references from README and UI adapter description
- Update `packages/adapter-agrenting/tutorial.md` to use `@agrentingai/paperclip-adapter` instead of old package name
- Add "Why Hire a Remote Agent" section to README explaining cost benefits

## 0.2.0 (2026-04-14)

### Features
- Add `hireAgent` for agent hiring via the Agrenting platform
- Add `getAgentProfile` for fetching agent profile data
- Add `sendMessageToTask` for messaging existing tasks
- Add `reassignTask` for task reassignment flows

### Fixes
- Fix empty `companyId` handling
- Deduplicate polling requests
- Add `AbortSignal` support for request cancellation
- Improve adapter client and test coverage
- Use `/api/v1/uploads` for documents with flat webhook shape
- Fix critical retry, webhook security, and API compatibility bugs
- Resolve merge conflicts — deduplicate types, functions, and exports

### Docs
- Add comprehensive tutorial for Paperclip + Agrenting adapter
- Document messaging, reassignment, and profile flows

## 0.1.0 (2026-04-12)

- Initial release
- Paperclip adapter for Agrenting platform
- Server and UI exports
