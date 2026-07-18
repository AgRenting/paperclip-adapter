# Changelog

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
