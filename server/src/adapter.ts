import { AgrentingClient } from "./client.js";
import type {
  AgrentingAdapterConfig,
  AgrentingExecutionResult,
  AgrentingTaskStatus,
  AgentInfo,
  AgentProfile,
  BalanceInfo as BalanceInfoRaw,
  HireAgentResult,
  PaymentInfo,
  ReassignTaskResult,
  SendMessageResult,
  TransactionInfo,
  DiscoverAgentsOptions,
  CreateTaskPaymentOptions,
  Hiring,
  TaskMessage,
  HiringMessage,
  Capability,
  AutoSelectOptions,
} from "./types.js";
import { registerTaskMapping } from "./webhook-handler.js";
import { pollTaskUntilDone } from "./polling.js";
import { canSubmitTask } from "./balance-monitor.js";
import { verifyWebhookSignature } from "./crypto.js";
import { formatAgentResponse } from "./comment-sync.js";

const DEFAULT_WEBHOOK_PORT = 8765;
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024; // 1MB — prevent OOM from oversized bodies
const STALE_TASK_CLEANUP_INTERVAL_MS = 60_000; // 60s
const STALE_TASK_TTL_MS = 2 * 60 * 60 * 1000; // 2h — max age before cleanup sweeps it

/** In-memory store for webhook listeners keyed by task ID */
const pendingTasks = new Map<
  string,
  {
    resolve: (result: AgrentingExecutionResult) => void;
    status: AgrentingTaskStatus;
    progressPercent: number;
    progressMessage?: string;
    startedAt: number;
    createdAt: number;
    settled: boolean;
  }
>();

let webhookServer: ReturnType<typeof import("http").createServer> | null = null;
let staleCleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sweep pendingTasks for entries that are settled or older than the TTL,
 * removing them from the map to bound memory usage.
 */
function sweepStaleTasks(): void {
  const now = Date.now();
  for (const [id, entry] of pendingTasks) {
    if (entry.settled || now - entry.createdAt > STALE_TASK_TTL_MS) {
      pendingTasks.delete(id);
    }
  }
}

/**
 * JSON Schema for Agrenting adapter configuration fields.
 * Used by Paperclip server to validate adapter config at creation time.
 */
export function getConfigSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["agrentingUrl", "apiKey", "agentDid"],
    properties: {
      agrentingUrl: {
        type: "string",
        format: "uri",
        description: "Agrenting platform URL (e.g. https://www.agrenting.com)",
        default: "https://www.agrenting.com",
      },
      apiKey: {
        type: "string",
        description: "Agrenting API key for authentication",
        sensitive: true,
      },
      agentDid: {
        type: "string",
        description:
          "Decentralized identifier of the target agent (did:agrenting:...)",
      },
      webhookSecret: {
        type: "string",
        description: "Webhook signing secret for task completion callbacks",
        sensitive: true,
      },
      webhookCallbackUrl: {
        type: "string",
        format: "uri",
        description:
          "URL where Agrenting should POST task events (e.g. https://your-host:8765/webhook)",
      },
      pricingModel: {
        type: "string",
        enum: ["fixed", "per-token", "subscription"],
        description: "Pricing model for this agent",
        default: "fixed",
      },
      timeoutSec: {
        type: "integer",
        minimum: 10,
        maximum: 3600,
        description: "Task timeout in seconds",
        default: 600,
      },
      instructionsBundleMode: {
        type: "string",
        enum: ["managed", "inline"],
        description: "How agent instructions are delivered",
        default: "inline",
      },
    },
  };
}

/**
 * Validate the adapter configuration and test connectivity.
 */
export async function testEnvironment(
  config: AgrentingAdapterConfig
): Promise<{ ok: boolean; message: string }> {
  const client = new AgrentingClient(config);
  return client.testConnection();
}

/**
 * Start an HTTP listener that receives webhook callbacks from Agrenting.
 * Returns the base URL of the listener (for registering with Agrenting).
 *
 * The listener resolves pending `execute()` calls when task events arrive.
 * Only call this once per process — subsequent calls return the existing server.
 */
export async function startWebhookListener(
  config: AgrentingAdapterConfig
): Promise<string> {
  if (webhookServer) {
    const addr = webhookServer.address();
    const port =
      typeof addr === "object" && addr ? addr.port : DEFAULT_WEBHOOK_PORT;
    return `http://localhost:${port}/webhook`;
  }

  const http = await import("http");
  const port = process.env.PAPERCLIP_WEBHOOK_PORT
    ? parseInt(process.env.PAPERCLIP_WEBHOOK_PORT, 10)
    : DEFAULT_WEBHOOK_PORT;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/webhook") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      let bodyChunks: Buffer[] = [];
      let bodyLength = 0;
      let bodyTooLarge = false;
      req.on("data", (chunk: Buffer) => {
        bodyLength += chunk.length;
        if (bodyLength > MAX_WEBHOOK_BODY_SIZE) {
          bodyTooLarge = true;
          res.writeHead(413);
          res.end("Request body too large");
          req.destroy();
          return;
        }
        bodyChunks.push(chunk);
      });

      req.on("end", async () => {
        if (bodyTooLarge) return;
        const rawBody = Buffer.concat(bodyChunks).toString("utf8");
        bodyChunks = []; // free reference for GC
        const taskId = req.headers["x-webhook-task-id"] as string | undefined;
        const signature =
          (req.headers["x-webhook-signature"] as string) || "";

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          res.writeHead(400);
          res.end("Invalid JSON");
          return;
        }

        // Verify signature if secret is configured
        if (config.webhookSecret) {
          if (!signature) {
            res.writeHead(401);
            res.end("Missing signature");
            return;
          }
          const valid = await verifyWebhookSignature(
            rawBody,
            signature,
            config.webhookSecret
          );
          if (!valid) {
            res.writeHead(401);
            res.end("Invalid signature");
            return;
          }
        }

        // Extract task ID from payload if not in header
        const resolvedTaskId =
          taskId ??
          (payload.task_id as string) ??
          (payload.taskId as string);

        if (resolvedTaskId) {
          const pending = pendingTasks.get(resolvedTaskId);
          if (pending && !pending.settled) {
            const status = (payload.status as AgrentingTaskStatus) ?? pending.status;
            pending.status = status;
            pending.progressPercent =
              (payload.progress_percent as number) ?? pending.progressPercent;
            pending.progressMessage =
              (payload.progress_message as string) ?? pending.progressMessage;

            if (status === "completed") {
              pending.settled = true;
              pending.resolve({
                success: true,
                output: (payload.output as string) ?? JSON.stringify(payload.output ?? {}),
                taskId: resolvedTaskId,
                durationMs: Date.now() - pending.startedAt,
              });
            } else if (status === "failed") {
              pending.settled = true;
              pending.resolve({
                success: false,
                error:
                  (payload.error_reason as string) ??
                  "Task failed with no reason provided",
                taskId: resolvedTaskId,
                durationMs: Date.now() - pending.startedAt,
              });
            } else if (status === "cancelled") {
              pending.settled = true;
              pending.resolve({
                success: false,
                error: "Task was cancelled",
                taskId: resolvedTaskId,
                durationMs: Date.now() - pending.startedAt,
              });
            }
          }
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      });
    });

    server.listen(port, () => {
      webhookServer = server;
      // Start periodic cleanup of stale entries
      if (!staleCleanupTimer) {
        staleCleanupTimer = setInterval(sweepStaleTasks, STALE_TASK_CLEANUP_INTERVAL_MS);
        staleCleanupTimer.unref();
      }
      resolve(`http://localhost:${port}/webhook`);
    });

    server.on("error", reject);
  });
}

const WEBHOOK_STOP_TIMEOUT_MS = 5_000;

/**
 * Stop the webhook listener if it was started.
 * Closes all active connections and waits up to 5s for a clean shutdown.
 */
export async function stopWebhookListener(): Promise<void> {
  if (!webhookServer) {
    return;
  }

  if (staleCleanupTimer) {
    clearInterval(staleCleanupTimer);
    staleCleanupTimer = null;
  }

  const server = webhookServer;
  webhookServer = null;

  // Force-close all active connections (Node 18.2+) so server.close() doesn't hang
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    (server as import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>).closeAllConnections();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve();
    }, WEBHOOK_STOP_TIMEOUT_MS);
    timeout.unref();

    server.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Register a webhook with Agrenting to receive task lifecycle events.
 * Returns the webhook ID and secret key.
 */
export async function registerWebhook(
  config: AgrentingAdapterConfig,
  callbackUrl?: string
): Promise<{
  id: string;
  secretKey: string;
  callbackUrl: string;
}> {
  const client = new AgrentingClient(config);
  const url = callbackUrl ?? (await startWebhookListener(config));

  const result = await client.registerWebhook({
    callbackUrl: url,
    eventTypes: [
      "task.created",
      "task.claimed",
      "task.in_progress",
      "task.completed",
      "task.failed",
      "task.cancelled",
    ],
  });

  return {
    id: result.id,
    secretKey: result.secret_key,
    callbackUrl: result.callback_url,
  };
}

/**
 * Deregister a webhook from Agrenting to stop receiving task lifecycle events.
 * Use this to clean up orphaned webhooks when they are no longer needed.
 */
export async function deregisterWebhook(
  config: AgrentingAdapterConfig,
  webhookId: string
): Promise<void> {
  const client = new AgrentingClient(config);
  await client.deleteWebhook(webhookId);
}

/**
 * Execute a task by submitting it to the Agrenting platform.
 *
 * Uses webhook callbacks when `webhookCallbackUrl` is configured in the adapter config
 * (or when `startWebhookListener()` has been called). Falls back to polling
 * when webhooks are not available.
 *
 * When `maxPrice` is provided, the task is created with a budget and escrow funds
 * are locked via `createTaskPayment()` after submission.
 */
export async function execute(
  config: AgrentingAdapterConfig,
  params: {
    input: string;
    capability: string;
    instructions?: string;
    /** Maximum price in USD to budget for this task. Triggers escrow payment. */
    maxPrice?: string;
    /** Payment type: "crypto" | "escrow" | "nowpayments". Defaults to "crypto". */
    paymentType?: string;
  }
): Promise<AgrentingExecutionResult> {
  const client = new AgrentingClient(config);
  const startTime = Date.now();

  // Upload instructions if managed mode is configured
  if (
    config.instructionsBundleMode === "managed" &&
    params.instructions
  ) {
    await client.uploadDocument({
      name: "instructions",
      content: params.instructions,
      documentType: "instructions",
    });
  }

  // Pre-submission balance check (non-blocking — logs warning but doesn't prevent)
  const balanceCheck = await canSubmitTask({ config });
  if (!balanceCheck.ok) {
    // Log but don't block — let the task fail naturally
    console.warn(`[adapter-agrenting] ${balanceCheck.reason}`);
  }

  // Submit the task to Agrenting
  const task = await client.createTask({
    providerAgentId: config.agentDid,
    capability: params.capability,
    input: params.input,
    maxPrice: params.maxPrice,
    paymentType: params.paymentType,
  });

  const taskId = task.id;

  // Lock escrow funds if a max price was specified.
  // If payment fails, cancel the orphaned task to avoid leaving it stuck on the server.
  let payment: PaymentInfo | undefined;
  if (params.maxPrice) {
    try {
      const paymentOptions: CreateTaskPaymentOptions = {};
      if (params.paymentType) paymentOptions.paymentType = params.paymentType;
      payment = await client.createTaskPayment(taskId, paymentOptions);
      console.log(`[adapter-agrenting] Escrow locked for task ${taskId}: ${payment.amount} ${payment.currency} (${payment.status})`);
    } catch (err) {
      console.error(`[adapter-agrenting] Failed to lock escrow for task ${taskId}, cancelling orphaned task:`, err);
      try {
        await client.cancelTask(taskId);
      } catch {
        // Best-effort cleanup — log but don't throw, the payment error is the real problem
      }
      return {
        success: false,
        error: `Escrow payment failed: ${err instanceof Error ? err.message : String(err)}`,
        taskId,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Register for webhook callbacks only when webhook mode is actually configured.
  // The taskRegistry in webhook-handler.ts is for the Paperclip-side webhook handler
  // (issue status updates), while pendingTasks below is for the in-process listener
  // (resolving execute() promises). They serve different purposes.
  if (config.webhookCallbackUrl || config.webhookSecret) {
    registerTaskMapping(taskId, taskId, config.agrentingUrl, config);
    return executeWithWebhook(client, config, taskId, startTime);
  }

  // Fall back to polling — delegate to pollTaskUntilDone
  return executeWithPolling(config, taskId, startTime);
}

/**
 * Execute with webhook: register a listener, submit task, wait for callback.
 * Falls back to polling if no webhook received within the grace period.
 */
async function executeWithWebhook(
  _client: AgrentingClient,
  config: AgrentingAdapterConfig,
  taskId: string,
  startTime: number
): Promise<AgrentingExecutionResult> {
  // Ensure the listener is running
  await startWebhookListener(config);

  const deadline = startTime + (config.timeoutSec ?? 600) * 1000;

  // AbortController for clean cancellation when webhook resolves first
  const abortController = new AbortController();

  // Register the pending task so the webhook handler can resolve it
  const pending = new Promise<AgrentingExecutionResult>((resolve) => {
    pendingTasks.set(taskId, {
      resolve,
      status: "pending",
      progressPercent: 0,
      startedAt: startTime,
      createdAt: Date.now(),
      settled: false,
    });
  }).then((result) => {
    // Webhook resolved — abort any in-flight polling
    abortController.abort();
    return result;
  });

  // Race between webhook callback and timeout
  const timeout = new Promise<AgrentingExecutionResult>((resolve) => {
    const ms = deadline - Date.now();
    setTimeout(() => {
      const entry = pendingTasks.get(taskId);
      if (entry && !entry.settled) {
        entry.settled = true;
      }
      resolve({
        success: false,
        error: `Task timed out after ${config.timeoutSec ?? 600}s`,
        taskId,
        durationMs: Date.now() - startTime,
      });
    }, Math.max(ms, 0));
  });

  // If webhook doesn't resolve within grace period, fall back to polling.
  // Polling is deferred so it only starts when the timeout actually fires,
  // avoiding wasted HTTP calls when the webhook wins.
  return Promise.race([pending, timeout.then(async (result) => {
    if (!result.success && result.error?.includes("timed out")) {
      const pollingFallback = await pollTaskUntilDone({
        config,
        taskId,
        deadline,
        signal: abortController.signal,
      });
      return pollingFallback.result;
    }
    return result;
  })]);
}

/**
 * Execute with polling by delegating to pollTaskUntilDone.
 * Avoids reimplementing the backoff loop that polling.ts already provides.
 */
async function executeWithPolling(
  config: AgrentingAdapterConfig,
  taskId: string,
  startTime: number
): Promise<AgrentingExecutionResult> {
  const deadline = startTime + (config.timeoutSec ?? 600) * 1000;
  const { result } = await pollTaskUntilDone({ config, taskId, deadline });
  return result;
}

/**
 * Get the current progress of a task including percentage and message.
 * Useful for progress monitoring in UI dashboards.
 */
export async function getTaskProgress(
  config: AgrentingAdapterConfig,
  taskId: string
): Promise<{
  status: AgrentingTaskStatus;
  progressPercent: number;
  progressMessage?: string;
  timeline: Array<{
    event_type: string;
    timestamp: string;
    progress_percent?: number;
    progress_message?: string;
  }>;
}> {
  const client = new AgrentingClient(config);
  const [progress, timeline] = await Promise.all([
    client.getTaskProgress(taskId),
    client.getTaskTimeline(taskId),
  ]);

  return {
    status: progress.status as AgrentingTaskStatus,
    progressPercent: progress.progress_percent,
    progressMessage: progress.progress_message,
    timeline: timeline.events,
  };
}

/**
 * Discover marketplace agents available for hire.
 * Filters by capability, price range, reputation, and availability.
 */
export async function discoverAgents(
  config: AgrentingAdapterConfig,
  options: DiscoverAgentsOptions = {}
): Promise<AgentInfo[]> {
  const client = new AgrentingClient(config);
  return client.discoverAgents(options);
}

/**
 * Get the current platform balance including available, escrowed, and total amounts.
 */
export async function getBalance(
  config: AgrentingAdapterConfig
): Promise<BalanceInfoRaw> {
  const client = new AgrentingClient(config);
  return client.getBalance();
}

/**
 * List recent ledger transactions.
 */
export async function getTransactions(
  config: AgrentingAdapterConfig,
  options: { limit?: number; offset?: number; type?: string } = {}
): Promise<TransactionInfo[]> {
  const client = new AgrentingClient(config);
  return client.getTransactions(options);
}

/**
 * Deposit funds into the Agrenting ledger.
 */
export async function deposit(
  config: AgrentingAdapterConfig,
  params: { amount: string; currency?: string; paymentMethod?: string }
): Promise<{ transaction_id: string; status: string; deposit_address?: string; payment_url?: string }> {
  const client = new AgrentingClient(config);
  return client.deposit(params);
}

/**
 * Withdraw funds from the Agrenting ledger to an external wallet.
 */
export async function withdraw(
  config: AgrentingAdapterConfig,
  params: { amount: string; currency?: string; withdrawalAddressId?: string }
): Promise<{ transaction_id: string; status: string }> {
  const client = new AgrentingClient(config);
  return client.withdraw(params);
}

/**
 * Get the payment status and escrow details for a task.
 */
export async function getTaskPayment(
  config: AgrentingAdapterConfig,
  taskId: string
): Promise<PaymentInfo | undefined> {
  const client = new AgrentingClient(config);
  try {
    return await client.getTaskPayment(taskId);
  } catch {
    return undefined;
  }
}

/**
 * Cancel a running task.
 */
export async function cancelTask(
  config: AgrentingAdapterConfig,
  taskId: string
): Promise<{ success: boolean; error?: string }> {
  const client = new AgrentingClient(config);
  try {
    await client.cancelTask(taskId);
    pendingTasks.delete(taskId);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to cancel task",
    };
  }
}

// -------------------------------------------------------------------------
// New adapter functions for hire, messaging, auto-select, and retry
// -------------------------------------------------------------------------

/** Task retry configuration */
const TASK_MAX_RETRIES = 2;
const TASK_RETRY_BASE_DELAY_MS = 1000; // 1s initial delay
const TASK_RETRY_MAX_DELAY_MS = 30_000; // 30s max delay

/**
 * Hire an agent by DID. Returns hiring record and adapter config for auto-provisioning.
 * This is the primary entry point for the "browse marketplace, click Hire" flow.
 */
export async function hireAgent(
  config: AgrentingAdapterConfig,
  agentDid: string
): Promise<HireAgentResult> {
  const client = new AgrentingClient(config);
  return client.hireAgent(agentDid);
}

/**
 * Get full agent profile by DID.
 * Returns description, capabilities, pricing, reputation, and availability.
 */
export async function getAgentProfile(
  config: AgrentingAdapterConfig,
  agentDid: string
): Promise<AgentProfile> {
  const client = new AgrentingClient(config);
  return client.getAgentProfile(agentDid);
}

/**
 * Send a message to an active task for bidirectional communication.
 * Used for sending follow-up instructions to the remote agent mid-task.
 */
export async function sendMessageToTask(
  config: AgrentingAdapterConfig,
  taskId: string,
  message: string
): Promise<SendMessageResult> {
  const client = new AgrentingClient(config);
  return client.sendMessageToTask(taskId, { message });
}

/**
 * Get messages for a task (bidirectional comment history).
 */
export async function getTaskMessages(
  config: AgrentingAdapterConfig,
  taskId: string
): Promise<TaskMessage[]> {
  const client = new AgrentingClient(config);
  return client.getTaskMessages(taskId);
}

/**
 * Reassign a failed/cancelled task to a different agent.
 * If newAgentDid is not provided, the system will auto-select a replacement.
 */
export async function reassignTask(
  config: AgrentingAdapterConfig,
  taskId: string,
  newAgentDid?: string
): Promise<ReassignTaskResult> {
  const client = new AgrentingClient(config);
  return client.reassignTask(taskId, newAgentDid);
}

/**
 * List all available capabilities with descriptions and usage stats.
 * Helps with agent discovery and validation.
 */
export async function listCapabilities(
  config: AgrentingAdapterConfig
): Promise<Capability[]> {
  const client = new AgrentingClient(config);
  return client.listCapabilities();
}

/**
 * Send a message to a hiring for communication with the hired agent.
 */
export async function sendMessageToHiring(
  config: AgrentingAdapterConfig,
  hiringId: string,
  message: string
): Promise<HiringMessage> {
  const client = new AgrentingClient(config);
  return client.sendMessageToHiring(hiringId, message);
}

/**
 * Get messages for a hiring.
 */
export async function getHiringMessages(
  config: AgrentingAdapterConfig,
  hiringId: string
): Promise<HiringMessage[]> {
  const client = new AgrentingClient(config);
  return client.getHiringMessages(hiringId);
}

/**
 * Retry a failed hiring.
 */
export async function retryHiring(
  config: AgrentingAdapterConfig,
  hiringId: string,
  options?: { reason?: string }
): Promise<Hiring> {
  const client = new AgrentingClient(config);
  return client.retryHiring(hiringId, options);
}

/**
 * Get a hiring by ID.
 */
export async function getHiring(
  config: AgrentingAdapterConfig,
  hiringId: string
): Promise<Hiring> {
  const client = new AgrentingClient(config);
  return client.getHiring(hiringId);
}

/**
 * List hirings for the authenticated agent.
 */
export async function listHirings(
  config: AgrentingAdapterConfig,
  options?: { status?: string; limit?: number; offset?: number }
): Promise<Hiring[]> {
  const client = new AgrentingClient(config);
  return client.listHirings(options);
}

/**
 * Auto-select mode: given a capability requirement, discover the best agent,
 * hire them, and return the adapter config for immediate use.
 *
 * Selection algorithm:
 * 1. Call listCapabilities() to validate capability exists
 * 2. Call GET /api/v1/agents filtered by capability
 * 3. Sort by: availability first, then reputation_score desc, then base_price asc
 * 4. Call hireAgent() to auto-provision
 * 5. Return adapter config
 */
export async function autoSelectAgent(
  config: AgrentingAdapterConfig,
  options: AutoSelectOptions
): Promise<HireAgentResult & { selectedAgent: AgentProfile }> {
  const client = new AgrentingClient(config);

  // 1. Validate capability exists
  const capabilities = await client.listCapabilities();
  const capabilityExists = capabilities.some(
    (c) => c.name === options.capability || c.name.toLowerCase() === options.capability.toLowerCase()
  );
  if (!capabilityExists) {
    throw new Error(`Capability "${options.capability}" not found. Available: ${capabilities.map(c => c.name).join(", ")}`);
  }

  // 2. Get agents filtered by capability
  const agents = await client.listAgentsByCapability(options.capability);
  if (agents.length === 0) {
    throw new Error(`No agents available for capability "${options.capability}"`);
  }

  // 3. Filter by options and sort
  let filtered = agents;

  // Filter by max price
  if (options.maxPrice) {
    const maxPriceNum = parseFloat(options.maxPrice);
    filtered = filtered.filter((a) => {
      if (!a.base_price) return true; // No price info = assume fits budget
      return parseFloat(a.base_price) <= maxPriceNum;
    });
  }

  // Filter by min reputation
  if (options.minReputation) {
    const minRep = options.minReputation;
    filtered = filtered.filter((a) => {
      if (!a.reputation_score) return false; // No reputation = excluded
      return a.reputation_score >= minRep;
    });
  }

  if (filtered.length === 0) {
    throw new Error(
      `No agents match criteria for capability "${options.capability}" (maxPrice=${options.maxPrice ?? "any"}, minReputation=${options.minReputation ?? "any"})`
    );
  }

  // Sort: availability first, then by specified sort criteria
  const sortBy = options.sortBy ?? "reputation_score";

  // Prefer available agents if requested
  if (options.preferAvailable ?? true) {
    filtered.sort((a, b) => {
      const aAvail = a.availability_status === "available" ? 0 : 1;
      const bAvail = b.availability_status === "available" ? 0 : 1;
      if (aAvail !== bAvail) return aAvail - bAvail;
      return 0;
    });
  }

  // Secondary sort
  filtered.sort((a, b) => {
    if (sortBy === "reputation_score") {
      return (b.reputation_score ?? 0) - (a.reputation_score ?? 0);
    }
    if (sortBy === "base_price") {
      const aPrice = parseFloat(a.base_price ?? "999999");
      const bPrice = parseFloat(b.base_price ?? "999999");
      return aPrice - bPrice;
    }
    if (sortBy === "availability") {
      const aAvail = a.availability_status === "available" ? 0 : 1;
      const bAvail = b.availability_status === "available" ? 0 : 1;
      return aAvail - bAvail;
    }
    return 0;
  });

  // 4. Hire the best agent
  const selectedAgent = filtered[0];
  const hireResult = await client.hireAgent(selectedAgent.did);

  // 5. Return combined result
  return {
    ...hireResult,
    selectedAgent,
  };
}

/**
 * Execute a task with retry logic.
 * If the task fails, it will be retried up to TASK_MAX_RETRIES times
 * with exponential backoff.
 */
export async function executeWithRetry(
  config: AgrentingAdapterConfig,
  params: {
    input: string;
    capability: string;
    instructions?: string;
    maxPrice?: string;
    paymentType?: string;
    maxRetries?: number;
  }
): Promise<AgrentingExecutionResult> {
  const maxRetries = params.maxRetries ?? TASK_MAX_RETRIES;
  let lastResult: AgrentingExecutionResult | undefined;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      lastResult = await execute(config, params);

      if (lastResult.success) {
        return lastResult;
      }

      // If task failed but we have retries remaining, wait and retry
      if (attempt < maxRetries && lastResult.error) {
        const delayMs = Math.min(
          TASK_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
          TASK_RETRY_MAX_DELAY_MS
        );
        console.warn(
          `[adapter-agrenting] Task failed on attempt ${attempt + 1}, retrying in ${delayMs}ms: ${lastResult.error}`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      return lastResult;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries) {
        const delayMs = Math.min(
          TASK_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
          TASK_RETRY_MAX_DELAY_MS
        );
        console.warn(
          `[adapter-agrenting] Execution error on attempt ${attempt + 1}, retrying in ${delayMs}ms: ${lastError.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }

  // All retries exhausted
  return {
    success: false,
    error: lastError?.message ?? lastResult?.error ?? "Task failed after all retries",
    taskId: lastResult?.taskId,
    durationMs: lastResult?.durationMs ?? 0,
  };
}

/**
 * Forward a comment from Paperclip to the Agrenting task.
 * Used for bidirectional comment sync when the user adds a comment
 * to a Paperclip issue that has an active Agrenting task.
 */
export async function forwardCommentToAgrenting(
  config: AgrentingAdapterConfig,
  taskId: string,
  comment: string,
  authorName?: string
): Promise<SendMessageResult | null> {
  const client = new AgrentingClient(config);

  // Format the comment for Agrenting
  const formattedComment = authorName
    ? `[${authorName}]: ${comment}`
    : comment;

  try {
    return await client.sendMessageToTask(taskId, { message: formattedComment });
  } catch (err) {
    // Log but don't throw — comment sync is non-critical
    console.error(
      `[adapter-agrenting] Failed to forward comment to task ${taskId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Process incoming Agrenting messages and format them for Paperclip.
 * Called by the webhook handler when it receives task messages.
 */
export function processIncomingMessage(
  message: TaskMessage
): string {
  const senderName = message.sender_name ?? "Agent";
  return formatAgentResponse(senderName, message.content);
}

/**
 * Create the server-side adapter module.
 * This is the entry point for Paperclip's server adapter registry.
 */
export function createServerAdapter() {
  return {
    name: "agrenting" as const,
    execute,
    testEnvironment,
    getConfigSchema,
    startWebhookListener,
    stopWebhookListener,
    registerWebhook,
    deregisterWebhook,
    getTaskProgress,
    getTaskPayment,
    cancelTask,
    discoverAgents,
    getAgentProfile,
    hireAgent,
    sendMessageToTask,
    getTaskMessages,
    reassignTask,
    listCapabilities,
    sendMessageToHiring,
    getHiringMessages,
    retryHiring,
    getHiring,
    listHirings,
    autoSelectAgent,
    executeWithRetry,
    forwardCommentToAgrenting,
    processIncomingMessage,
    getBalance,
    getTransactions,
    deposit,
    withdraw,
  };
}
