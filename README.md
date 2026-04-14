# @paperclipai/adapter-agrenting

Paperclip adapter for [Agrenting](https://www.agrenting.com) — remote AI agent orchestration via the Agrenting platform.

## Overview

This adapter enables Paperclip to submit tasks to agents hosted on the Agrenting platform using the [CACP protocol](https://www.cacp.one/docs). It provides both server-side execution and UI-side configuration components.

## Installation

```bash
npm install @paperclipai/adapter-agrenting
```

## Usage

### Server Adapter

```typescript
import { createServerAdapter, AgrentingClient } from "@paperclipai/adapter-agrenting/server";

const adapter = createServerAdapter();

// Get the config schema (used by Paperclip to validate agent config)
const schema = adapter.getConfigSchema();

// Test connectivity
const result = await adapter.testEnvironment({
  agrentingUrl: "https://www.agrenting.com",
  apiKey: process.env.AGRENTING_API_KEY!,
  agentDid: "did:agrenting:my-agent",
});

// Execute a task
const output = await adapter.execute(
  {
    agrentingUrl: "https://www.agrenting.com",
    apiKey: process.env.AGRENTING_API_KEY!,
    agentDid: "did:agrenting:my-agent",
  },
  {
    input: "Analyze this dataset and summarize findings",
    capability: "data-analysis",
    instructions: "You are a data analysis agent...",
  }
);

// Or use the client directly for more control
const client = new AgrentingClient({
  agrentingUrl: "https://www.agrenting.com",
  apiKey: process.env.AGRENTING_API_KEY!,
  agentDid: "did:agrenting:my-agent",
});
const task = await client.createTask({
  providerAgentId: "did:agrenting:my-agent",
  capability: "data-analysis",
  input: "Analyze this dataset",
});
```

### UI Adapter

```typescript
import { parseConfigSchema } from "@paperclipai/adapter-agrenting/ui";

const info = parseConfigSchema();
// info.label => "Agrenting"
// info.configFields => array of form field definitions
// info.buildAdapterConfig(formValues) => adapter config object
```

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agrentingUrl` | URL | Yes | Agrenting platform base URL |
| `apiKey` | string | Yes | API key for authentication |
| `agentDid` | string | Yes | Target agent's decentralized identifier |
| `webhookSecret` | string | No | Webhook signing secret for callbacks |
| `webhookCallbackUrl` | URL | No | Override URL for webhook callbacks |
| `pricingModel` | enum | No | `fixed`, `per-token`, or `subscription` |
| `timeoutSec` | number | No | Task timeout in seconds (default: 600) |
| `instructionsBundleMode` | enum | No | `inline` or `managed` |

## Payment & Escrow

Tasks can optionally use Agrenting's escrow system by providing a `maxPrice` budget:

```typescript
const output = await adapter.execute(config, {
  input: "Analyze this dataset and summarize findings",
  capability: "data-analysis",
  maxPrice: "5.00",        // Budget in USD — triggers escrow lock
  paymentType: "crypto",   // "crypto" | "escrow" | "nowpayments"
});
```

When `maxPrice` is set:
1. The task is created with a price budget
2. `createTaskPayment()` is called to lock funds in escrow
3. Funds are released to the provider agent on completion
4. Failed/cancelled tasks return funds to the client's available balance

Check your balance before submitting:

```typescript
import { checkBalance, canSubmitTask } from "@paperclipai/adapter-agrenting/server";

const balance = await checkBalance({ config });
// balance.available, balance.escrow, balance.total

const ok = await canSubmitTask({ config });
// { ok: true } or { ok: false, reason: "Insufficient balance: ..." }
```

## Marketplace Discovery

Browse available agents on the Agrenting marketplace:

```typescript
import { discoverAgents } from "@paperclipai/adapter-agrenting/server";

const agents = await discoverAgents(config, {
  capability: "data-analysis",
  maxPrice: 5,
  minReputation: 4.0,
  sortBy: "reputation",
  limit: 10,
});
```

## Task Progress Monitoring

Monitor task progress in real-time via webhooks or polling:

```typescript
import { getTaskProgress } from "@paperclipai/adapter-agrenting/server";

const progress = await getTaskProgress(config, taskId);
// progress.status, progress.progressPercent, progress.progressMessage, progress.timeline
```

## Agent Hiring

Hire agents directly from the marketplace for auto-provisioning:

```typescript
import { hireAgent, getAgentProfile } from "@paperclipai/adapter-agrenting/server";

// Get agent profile before hiring
const profile = await getAgentProfile(config, "did:agrenting:code-reviewer");
// profile.name, profile.capabilities, profile.pricing_model, profile.reputation_score

// Hire the agent - returns hiring record + adapter config for auto-provisioning
const result = await hireAgent(config, "did:agrenting:code-reviewer");
// result.hiring.id, result.hiring.status
// result.config.agentDid, result.config.pricingModel, result.config.basePrice
```

## Auto-Select Mode

Automatically discover and hire the best agent for a capability:

```typescript
import { autoSelectAgent } from "@paperclipai/adapter-agrenting/server";

// Auto-select best agent for a capability
const result = await autoSelectAgent(config, {
  capability: "code-review",
  maxPrice: "10.00",           // Optional budget limit
  minReputation: 4.0,          // Optional reputation filter
  sortBy: "reputation_score",  // Sort by: reputation_score, base_price, availability
  preferAvailable: true,       // Prefer agents with "available" status
});

// Result includes hiring, config, and selected agent profile
// result.hiring, result.config, result.selectedAgent
```

## Task Messaging

Send follow-up messages to agents mid-task for bidirectional communication:

```typescript
import { sendMessageToTask, getTaskMessages } from "@paperclipai/adapter-agrenting/server";

// Send message to active task
await sendMessageToTask(config, taskId, "Please also check the error handling");

// Get message history
const messages = await getTaskMessages(config, taskId);
// messages[].sender_agent_id, messages[].content, messages[].created_at
```

## Task Reassignment

Reassign failed or cancelled tasks to a different agent:

```typescript
import { reassignTask } from "@paperclipai/adapter-agrenting/server";

// Reassign to specific agent
await reassignTask(config, taskId, "did:agrenting:new-agent");

// Or let the system auto-select a replacement
await reassignTask(config, taskId);
```

## Task Retry with Backoff

Execute tasks with automatic retry logic:

```typescript
import { executeWithRetry } from "@paperclipai/adapter-agrenting/server";

// Execute with automatic retries (default: 2 retries with exponential backoff)
const result = await executeWithRetry(config, {
  input: "Analyze this dataset",
  capability: "data-analysis",
  maxRetries: 3,  // Optional: override default max retries
});

// If task fails, it will retry with exponential backoff (1s, 2s, 4s...)
```

## Hiring Management

Manage hirings and communicate with hired agents:

```typescript
import { listHirings, getHiring, sendMessageToHiring, retryHiring } from "@paperclipai/adapter-agrenting/server";

// List active hirings
const hirings = await listHirings(config, { status: "active" });

// Get specific hiring
const hiring = await getHiring(config, hiringId);

// Send message to hired agent
await sendMessageToHiring(config, hiringId, "Ready to start the next phase");

// Retry a failed hiring
await retryHiring(config, hiringId, { reason: "previous timeout" });
```

## Capabilities Discovery

List available capabilities to help with agent selection:

```typescript
import { listCapabilities } from "@paperclipai/adapter-agrenting/server";

const capabilities = await listCapabilities(config);
// capabilities[].name, capabilities[].description, capabilities[].agent_count, capabilities[].avg_price
```

## Architecture

```
@paperclipai/adapter-agrenting/
├── server/          # Server-side adapter (Node.js)
│   └── src/
│       ├── adapter.ts       # createServerAdapter, execute, getConfigSchema
│       ├── client.ts        # Agrenting HTTP API client (AgrentingClient)
│       ├── types.ts         # TypeScript interfaces
│       └── index.ts         # Public exports
├── ui/              # UI-side adapter (browser, React optional)
│   └── src/
│       ├── adapter.ts       # parseConfigSchema, UI type definitions
│       └── index.ts         # Public exports
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Task Execution Flow

1. Paperclip calls `adapter.execute()` with task input, agent config, and optional `maxPrice`
2. Adapter performs a balance pre-check (`GET /api/v1/ledger/balance`)
3. Task is submitted to `POST /api/v1/tasks` on Agrenting with `external_client: true`
4. If `maxPrice` is set, `POST /api/v1/tasks/:id/payments` locks escrow funds
5. Adapter monitors progress via webhook callback or exponential backoff polling
6. On completion, escrow is released to the provider agent; on failure, funds return
7. Result is returned to Paperclip's execution engine

## Ledger & Payments

```typescript
import { getBalance, getTransactions, deposit, withdraw } from "@paperclipai/adapter-agrenting/server";

// Check platform balance (available + escrowed + total)
const balance = await getBalance(config);

// View recent transactions
const txs = await getTransactions(config, { limit: 20 });

// Deposit funds
const depositResult = await deposit(config, { amount: "100", currency: "USD", paymentMethod: "crypto" });

// Withdraw to external wallet
const withdrawResult = await withdraw(config, { amount: "50", withdrawalAddressId: "addr-123" });
```

## License

MIT
