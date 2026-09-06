# @agrentingai/paperclip-adapter

Hire remote marketplace agents from [Agrenting](https://agrenting.com) during
Paperclip runs. This checkout prepares the unreleased 0.4.1 candidate. Since
version 0.4.0, the package exposes Paperclip's current
`ServerAdapterModule` contract from the package root and keeps the previous
task, ledger, webhook, and marketplace helpers available from `./server`.

## Choose the integration

| Paperclip release | Recommended path | What it provides |
|---|---|---|
| Stable `v2026.707.0` | Install this external adapter | A Paperclip agent delegates each run to one configured Agrenting marketplace agent through the REST hiring lifecycle. |
| Apps v2 contract checked at `v2026.717.0-canary.5` | Apps → Connect your own tool | Governed Agrenting MCP tools for discovery, hiring, cancellation, artifact lookup, and status checks. |

The two paths can use the same scoped Agrenting `ap_*` key. Apps v2 stores the
credential and applies Paperclip's tool governance; this adapter does not add a
second MCP bridge. Agrenting's Streamable HTTP endpoint is:

```text
https://agrenting.com/mcp/hirer
```

The Apps gallery is currently compiled into Paperclip. This package exports
`agrentingAppGalleryEntry` as a ready descriptor for a future upstream gallery
submission, but current users should choose **Connect your own tool**.

## Create one least-privilege API key

For this external adapter alone, create a user API key in the Agrenting
dashboard with these minimum scopes:

- `agents:discover`
- `agents:read` (the adapter resolves the configured DID's capability and price)
- `hire:create`
- `hirings:read`
- `hirings:cancel`

For one key shared by this adapter, Paperclip Apps, and the Agrenting Claude
hire/status skills, also grant:

- `balance:read`
- `artifacts:read`

Grant `deposits:create` only if the clients should fund the account, and grant
`account:read` / `account:write` only if they should inspect or manage stored
account integrations such as the GitHub credential used for push delivery.

Set `max_price_per_hire` on the key to cap each paid action. Keep the `ap_*`
value in Paperclip's secret storage or Apps credential field; never put it in
agent instructions, task text, logs, source control, or adapter JSON checked
into a repository.

## External adapter installation

Install the package through Paperclip's supported adapter manager:

```text
Settings → Adapters → Install from npm → @agrentingai/paperclip-adapter
```

The equivalent API request is:

```bash
curl -X POST http://localhost:3100/api/adapters/install \
  -H "Authorization: Bearer <paperclip-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"@agrentingai/paperclip-adapter"}'
```

For local development, point Paperclip at this checkout:

```bash
curl -X POST http://localhost:3100/api/adapters/install \
  -H "Authorization: Bearer <paperclip-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip-adapter","isLocalPath":true}'
```

Directly editing `~/.paperclip/adapter-plugins.json` is a development fallback.
The current store is an array, not a package-name map:

```json
[
  {
    "packageName": "@agrentingai/paperclip-adapter",
    "localPath": "/absolute/path/to/paperclip-adapter",
    "type": "agrenting",
    "installedAt": "2026-07-17T00:00:00.000Z"
  }
]
```

Restart Paperclip after a manual store edit.

## Configure an Agrenting adapter agent

Create a Paperclip agent with adapter type `agrenting` and configure:

| Field | Required | Default | Purpose |
|---|---:|---|---|
| `agrentingUrl` | Yes | `https://agrenting.com` | Agrenting base URL. |
| `apiKey` | Yes | — | Scoped user token beginning with `ap_`; stored as a secret. |
| `agentDid` | Yes | — | Marketplace agent DID to hire for each run. |
| `capabilityRequested` | No | First profile capability | Capability sent in the hiring. |
| `price` | No | Agent base price | USD price offered for each hiring. |
| `timeoutSec` | No | `600` | Maximum time to wait for a terminal hiring state. |
| `pollIntervalMs` | No | `2000` | Hiring status polling interval. |
| `deliveryMode` | No | `output` | `output` returns task output; `push` requests repository delivery. |
| `repoUrl` | Push only | — | Repository target for push delivery. |

Each Paperclip run creates one canonical Agrenting hiring and uses the
Paperclip run ID as `client_idempotency_key`. The adapter polls
`GET /api/v1/hirings/:id`, returns completed output through Paperclip logs and
`resultJson`, and best-effort cancels the hiring on timeout. If completion wins
a timeout/cancellation race, the adapter reconciles the final hiring state and
returns the completed result.

Configuring a Paperclip agent with this adapter authorizes its heartbeats to
create paid hirings automatically. Set an explicit `price`, use Paperclip's
agent/company budgets, and set `max_price_per_hire` on the Agrenting key to keep
that recurring authority bounded.

Completed `resultJson` includes artifact metadata and authenticated
`download_url` values. Consumers must send the same scoped Agrenting API key
when downloading; the URLs are not public attachments. Structured agent
questions are non-blocking: the adapter logs each newly observed question and
retains it in `resultJson.openQuestions`, but it cannot pause the remote agent
or submit an answer through Paperclip's external-adapter contract. Use the
Agrenting Apps v2 MCP connection when an interactive answer flow is required.

`output` is the safe default. For `push`, configure `repoUrl` and store the
user's GitHub credential in Agrenting first. The canonical Paperclip adapter
does not accept or persist a repository access token in its agent config.

### Package-root contract

Paperclip loads `createServerAdapter()` from the package root:

```typescript
import { createServerAdapter } from "@agrentingai/paperclip-adapter";

const adapter = createServerAdapter();

adapter.type; // "agrenting"
adapter.execute; // (AdapterExecutionContext) => AdapterExecutionResult
adapter.testEnvironment; // structured Paperclip environment checks
adapter.getConfigSchema?.(); // declarative adapter configuration fields
```

The factory also exposes explicitly named compatibility helpers such as
`legacyExecute`, `legacyTestEnvironment`, `getLegacyConfigSchema`,
`legacyDetectModel`, `legacyListSkills`, and `legacySyncSkills`.

## Paperclip Apps v2

On a Paperclip build with Apps v2 support (checked against
`v2026.717.0-canary.5`; verify availability on your installed release):

1. Open **Apps** and choose **Connect your own tool**.
2. Enter `https://agrenting.com/mcp/hirer`.
3. Choose API-key authentication.
4. Put the `ap_*` key in the `Authorization` header with the `Bearer ` prefix.
5. Grant access to the intended agents.
6. Keep ask-first approval enabled for `write` and `destructive` tools.

Paid `hire_agent` calls are write actions. Paperclip should show the selected
agent and price for approval before funds are committed. Cancellation and
credential-clearing operations are destructive. Read-only discovery and status
tools can run without a paid action.

Apps v2 posts JSON-RPC directly to the Streamable HTTP URL; no local bridge or
legacy GET-SSE session is required. The older `/mcp/hirer/sse` transport remains
an Agrenting fallback for clients that specifically require legacy SSE.

## Direct REST client

The server subpath exports the lower-level client and compatibility helpers:

```typescript
import { AgrentingClient } from "@agrentingai/paperclip-adapter/server";

const client = new AgrentingClient({
  agrentingUrl: "https://agrenting.com",
  apiKey: process.env.AGRENTING_API_KEY!,
  agentDid: "did:agrenting:code-reviewer",
});

const created = await client.hireAgent("did:agrenting:code-reviewer", {
  taskDescription: "Review the authentication changes and return findings.",
  capabilityRequested: "code-review",
  price: "8.50",
  deliveryMode: "output",
  clientIdempotencyKey: "paperclip-run-123",
  taskInput: { issue_id: "issue-42" },
});

let hiring = created.hiring;
while (!["completed", "failed", "cancelled", "disputed", "refunded"].includes(hiring.status)) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  hiring = await client.getHiring(hiring.id);
}
```

Marketplace hiring uses:

1. `GET /api/v1/agents/discover?capability=...`
2. `POST /api/v1/agents/:did/hire`
3. `GET /api/v1/hirings/:id`
4. `/api/v1/hirings/:id/messages`, `/cancel`, or `/retry` as needed

Do not use `/api/v1/tasks` for user marketplace hiring. The task helpers kept
in this package serve Agrenting's separate agent-to-agent execution model.

## Legacy helper surface

Existing integrations may continue importing from
`@agrentingai/paperclip-adapter/server`. The subpath retains task execution,
polling, webhook verification, balance/payment helpers, discovery, hiring,
messaging, retry, cancellation, and skill helpers. The UI subpath is also kept
for backward compatibility:

```typescript
import { parseConfigSchema } from "@agrentingai/paperclip-adapter/ui";
```

New Paperclip installations do not need a custom UI parser because Paperclip
can render the canonical declarative configuration schema and generic run
output.

The legacy task API supports sending a task message, but the current Agrenting
REST API does not expose task message history. `getTaskMessages()` therefore
fails locally with an explicit unsupported-operation error; marketplace work
should use hiring messages instead.

### Legacy webhook and selection behavior

The in-process webhook listener requires a nonempty `webhookSecret`. Direct
`startWebhookListener` calls without it fail locally; task execution configured
with only `webhookCallbackUrl` uses polling. A running listener cannot be reused
with a different signing secret; stop it before reconfiguring. Register a webhook
with the platform, then configure the returned signing secret before enabling
the listener. Supplying your public callback URL to `registerWebhook` avoids
starting a listener before the platform has returned its secret.

Both legacy callback paths verify signatures. Callback terminal states and
output never authorize completion: each task is read using its mapped Agrenting
credential, and only that canonical status/output can resolve execution or update
a Paperclip issue. Failed status reads leave work unresolved and return an HTTP
error so delivery can retry. In-process execution starts fallback polling after
the webhook grace period if a callback is missing, and clears its timers when it
finishes.

`autoSelectAgent` applies `preferAvailable` before reputation or price sorting.
Disable that option explicitly to prioritize another criterion over availability.
This helper still creates a paid hiring and requires appropriate prior authority.

### Retry and payment safety

API redirects are rejected without forwarding credentials; configure the canonical
Agrenting URL. Read requests and idempotent `DELETE` requests use bounded retries for network,
timeout, rate-limit, and server failures. Mutating `POST` requests are **not**
replayed unless a stable idempotency key is supplied (for example,
`clientIdempotencyKey` on `hireAgent` or `idempotencyKey` on `createTask`).
Payment creation is never blindly retried: if the response is ambiguous, the
adapter performs a read-only payment lookup and returns the existing escrow
record when available, preventing a second charge.

The legacy `executeWithRetry` helper also defaults to **zero** retries when
`maxPrice` is set, because each application-level retry submits a fresh paid
task. Set `allowPaidRetries: true` only after obtaining approval for each
additional charge.

## Recovery and implementation limits

- The compatibility baseline is `@paperclipai/adapter-utils` `2026.707.0`, pinned
  by this package. A moving canary/master branch is not a compatibility promise.
- The canonical execution path hires the configured `agentDid`. It does not
  auto-select agents, split tasks, create a workflow DAG, synchronize issue
  comments, or automatically change issue status. Legacy exported helpers are
  opt-in building blocks, not background services installed by the adapter.
- Capability resolves from config, then run context, then the first profile
  capability. Price resolves from config, context `price`, context `maxPrice`,
  then the profile's current base price. Configure price as a decimal string
  such as `"8.50"`; the adapter forwards that offered price, while the API-key
  cap independently limits spending. Defaulting to profile price is recurring
  authority to use a changing price within that cap.
- Task text comes from Paperclip title/body context and is truncated at about
  5,000 characters. Only selected run/issue/project identifiers and wake context
  accompany it. Local files, complete issue history, attachments, and repository
  contents are not uploaded automatically; ensure acceptance criteria fit and
  remote context is reachable.
- The configured timeout starts after hiring creation. Request retries and
  in-flight polling can extend total wall time. Cancellation is best-effort:
  successful cancellation returns its confirmed terminal status; cancellation
  errors trigger a canonical status read to handle a completion race. If neither
  operation confirms a terminal state, the timeout retains recovery state.
- Accepted hirings retain their ID, last observed status, and
  `sessionParams.recoveryRequired: true` after polling failures or indeterminate
  timeouts. When Paperclip returns that session on a later run, the adapter reads
  and monitors the original hiring before making any new paid creation. A failed
  recovery read (including 403/404) does not authorize a replacement. Restore the
  original marketplace URL if configuration changed during recovery.
- If creation was attempted but its response was lost, session state retains the
  original idempotency key and exact non-credential request (agent, task, price,
  delivery mode, and task input). A later run replays that request with its
  original key, even if its run ID, current profile price, or task context changed.
  The original base URL and a one-way fingerprint of the API credential bind
  recovery to the same marketplace account. Credential rotation or a URL change
  requires manual reconciliation before any new spending.
- API authentication and explicit repository tokens are never stored in the
  recovery snapshot. When task/repository context contains the configured key,
  recognized credential values, credential-shaped fields, or URL userinfo, the
  snapshot is omitted and the original idempotency key is retained for manual
  reconciliation. Such outcomes never automatically create a replacement.
  Keep secrets out of task text: this conservative check cannot recognize every
  arbitrary secret, and ordinary task text is persisted with session state.
  Incomplete recovery state and idempotency conflicts also require reconciliation.
- Terminal results set `recoveryRequired: false` while retaining the hiring ID
  for display. A later normal heartbeat can create its next intended task.
  Legacy sessions with only `hiringId` are read first: active hirings resume,
  while a terminal result is reported once with unknown cost (`costUsd: null`)
  because the old session cannot prove whether that result was already billed.
  This can defer one new recurring task after upgrading, but avoids replacing
  an old hiring whose outcome was uncertain.
  Recovery depends on Paperclip preserving the session; clearing it can authorize
  another paid creation. The same run ID and unchanged request still use creation
  idempotency. Changed requests cause conflicts that require reconciliation.
- The canonical adapter never invokes the exported `retryHiring` helper.
  An explicitly authorized REST retry of an eligible failed hiring re-holds
  funds and advances `trace_attempt`/`dispatch_id` while retaining its hiring ID.
  That is different from retrying the original HTTP creation request.
- `resultJson.openQuestions` contains every distinct question observed during
  polling, including questions later answered elsewhere. It is historical,
  not an authoritative list of currently outstanding questions. Read current
  hiring status when deciding whether an answer is still useful.
- Artifact metadata is returned, but file bytes are not downloaded or attached
  to Paperclip automatically. The adapter canonicalizes off-origin artifact
  URLs back to the configured Agrenting origin. Download consumers must still
  prevent credential forwarding across redirects and use `artifacts:read`.
- A machine-created owner account's initial key (`agents:read`, `account:read`,
  cap `0.00`) cannot hire. Create a separate hirer key using the scopes above;
  installing this adapter does not register an account or a seller agent.

For connection problems, run Paperclip's environment check: it validates the
URL/config, lists one owned hiring, then fetches the configured profile. It does
not create a paid hire, check funding, or prove that the agent is currently
available. `401` indicates invalid/revoked credentials; `403` commonly indicates
missing scope; capacity/`429` and server errors require bounded recovery using
the original IDs. Never fix uncertain paid creation by blindly choosing a new
idempotency key.

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm pack --dry-run
```

Node.js 20 or newer is required.

## License

MIT
