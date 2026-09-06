import { AgrentingClient } from "./client.js";
import type {
  AgrentingAdapterConfig,
  AgrentingExecutionResult,
  AgrentingTaskStatus,
  AgentInfo,
  AgentProfile,
  BalanceInfo as BalanceInfoRaw,
  HireAgentResult,
  HireAgentOptions,
  PaymentInfo,
  ReassignTaskResult,
  SendMessageResult,
  TransactionInfo,
  DiscoverAgentsOptions,
  Hiring,
  TaskMessage,
  HiringMessage,
  Capability,
  AutoSelectOptions,
} from "./types.js";
import {
  createCanonicalServerAdapter,
  paperclipSessionCodec,
} from "./paperclip.js";
import { registerTaskMapping } from "./webhook-handler.js";
import { getWebhookGracePeriodMs, pollTaskUntilDone } from "./polling.js";
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
    client: AgrentingClient;
  }
>();

let webhookServer: ReturnType<typeof import("http").createServer> | null = null;
let webhookListenerSecret: string | null = null;
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
        description: "Agrenting platform URL (e.g. https://agrenting.com)",
        default: "https://agrenting.com",
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
  const secret = config.webhookSecret;
  if (!secret?.trim()) throw new Error("A webhook signing secret is required to start the listener.");
  if (webhookServer) {
    if (webhookListenerSecret !== secret) {
      throw new Error("The webhook listener is already configured with a different signing secret.");
    }
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

        if (!await verifyWebhookSignature(rawBody, signature, secret)) {
          res.writeHead(401);
          res.end("Invalid or missing signature");
          return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          res.writeHead(400);
          res.end("Invalid payload");
          return;
        }

        // Only signed payload identity is trusted; headers cannot redirect an
        // event to another task. The callback is a notification, not a result.
        const resolvedTaskId = payload.task_id ?? payload.taskId;
        const pending = typeof resolvedTaskId === "string" ? pendingTasks.get(resolvedTaskId) : undefined;
        if (pending && !pending.settled) {
          try {
            const task = await pending.client.getTask(String(resolvedTaskId));
            if (task.id !== resolvedTaskId) throw new Error("Canonical task ID mismatch");
            if (!pending.settled) {
              pending.status = task.status;
              pending.progressPercent = task.progress_percent ?? pending.progressPercent;
              pending.progressMessage = task.progress_message ?? pending.progressMessage;
              if (["completed", "failed", "cancelled"].includes(task.status)) {
                pending.settled = true;
                pending.resolve({
                  success: task.status === "completed",
                  ...(task.status === "completed" ? { output: task.output } : {
                    error: task.status === "cancelled" ? "Task was cancelled" : task.error_reason ?? "Task failed with no reason provided",
                  }),
                  taskId: task.id,
                  durationMs: Date.now() - pending.startedAt,
                });
              }
            }
          } catch {
            res.writeHead(503);
            res.end("Canonical task status unavailable");
            return;
          }
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      });
    });

    server.listen(port, () => {
      webhookServer = server;
      webhookListenerSecret = secret;
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
  webhookListenerSecret = null;

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
 * Uses authenticated webhook notifications when `webhookSecret` is configured.
 * A callback URL without a signing secret uses polling. Canonical task reads
 * authorize results; callback payloads never supply task output.
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

  if (config.webhookSecret?.trim()) await startWebhookListener(config);

  const provider = await client.getAgentProfile(config.agentDid);

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
    providerAgentId: provider.id,
    capability: params.capability,
    input: params.input,
    maxPrice: params.maxPrice,
    paymentType: params.paymentType,
  });

  const taskId = task.id;

  // Current Agrenting creates and holds billable-task escrow atomically with
  // task creation. Replaying a second payment request would return ALREADY_PAID.
  const payment = task.payment;
  if (payment) {
    console.log(`[adapter-agrenting] Escrow locked for task ${taskId}: ${payment.amount} ${payment.currency} (${payment.status})`);
  }

  // Register for webhook callbacks only when webhook mode is actually configured.
  // The taskRegistry in webhook-handler.ts is for the Paperclip-side webhook handler
  // (issue status updates), while pendingTasks below is for the in-process listener
  // (resolving execute() promises). They serve different purposes.
  if (config.webhookSecret?.trim()) {
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
  client: AgrentingClient,
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
      client,
    });
  }).then((result) => {
    // Webhook resolved — abort any in-flight polling
    abortController.abort();
    return result;
  });

  let timeoutTimer: ReturnType<typeof setTimeout>;
  let graceTimer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<AgrentingExecutionResult>((resolve) => {
    timeoutTimer = setTimeout(() => resolve({
      success: false,
      error: `Task timed out after ${config.timeoutSec ?? 600}s`,
      taskId,
      durationMs: Date.now() - startTime,
    }), Math.max(deadline - Date.now(), 0));
  });
  const polling = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, getWebhookGracePeriodMs(config));
  }).then(async () => {
    try {
      const result = await pollTaskUntilDone({ config, taskId, deadline, signal: abortController.signal });
      return result.result;
    } catch {
      // A failed read does not fail the remote task. Keep authenticated
      // callbacks and the original deadline active after polling is exhausted.
      return pending;
    }
  });
  try {
    return await Promise.race([pending, timeout, polling]);
  } finally {
    clearTimeout(timeoutTimer!);
    clearTimeout(graceTimer!);
    const entry = pendingTasks.get(taskId);
    if (entry) entry.settled = true;
    pendingTasks.delete(taskId);
    abortController.abort();
  }
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
  agentDid: string,
  options: HireAgentOptions
): Promise<HireAgentResult> {
  const client = new AgrentingClient(config);
  return client.hireAgent(agentDid, options);
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

/** Cancel an active hiring and release its escrow according to Agrenting policy. */
export async function cancelHiring(
  config: AgrentingAdapterConfig,
  hiringId: string
): Promise<Hiring> {
  const client = new AgrentingClient(config);
  return client.cancelHiring(hiringId);
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
      const reputation = Number(a.reputation_score);
      return Number.isFinite(reputation) && reputation >= minRep;
    });
  }

  if (filtered.length === 0) {
    throw new Error(
      `No agents match criteria for capability "${options.capability}" (maxPrice=${options.maxPrice ?? "any"}, minReputation=${options.minReputation ?? "any"})`
    );
  }

  // Sort: availability first, then by specified sort criteria
  const sortBy = options.sortBy ?? "reputation_score";

  filtered.sort((a, b) => {
    if (options.preferAvailable ?? true) {
      const aAvailable = (a.availability_status ?? a.availability ?? a.status) === "available";
      const bAvailable = (b.availability_status ?? b.availability ?? b.status) === "available";
      if (aAvailable !== bAvailable) return aAvailable ? -1 : 1;
    }
    if (sortBy === "reputation_score") {
      const aReputation = Number(a.reputation_score ?? 0);
      const bReputation = Number(b.reputation_score ?? 0);
      return (
        (Number.isFinite(bReputation) ? bReputation : 0) -
        (Number.isFinite(aReputation) ? aReputation : 0)
      );
    }
    if (sortBy === "base_price") {
      const aPrice = parseFloat(a.base_price ?? "999999");
      const bPrice = parseFloat(b.base_price ?? "999999");
      return aPrice - bPrice;
    }
    if (sortBy === "availability") {
      const aAvail =
        (a.availability_status ?? a.availability ?? a.status) === "available"
          ? 0
          : 1;
      const bAvail =
        (b.availability_status ?? b.availability ?? b.status) === "available"
          ? 0
          : 1;
      return aAvail - bAvail;
    }
    return 0;
  });

  // 4. Hire the best agent
  const selectedAgent = filtered[0];
  const hireResult = await client.hireAgent(selectedAgent.did, {
    taskDescription: options.taskDescription,
    capabilityRequested: options.capability,
    price: selectedAgent.base_price ?? options.maxPrice ?? "0",
    deliveryMode: "output",
  });

  // 5. Return combined result
  return {
    ...hireResult,
    selectedAgent,
  };
}

/**
 * Execute a task with retry logic.
 *
 * Paid task execution is not retried by default: each retry creates a new task
 * and can place another escrow hold. Callers that have separately approved
 * each additional charge may opt in with `allowPaidRetries`.
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
    /** Explicitly approve additional paid task submissions on failure. */
    allowPaidRetries?: boolean;
  }
): Promise<AgrentingExecutionResult> {
  const maxRetries =
    params.maxPrice && !params.allowPaidRetries
      ? 0
      : params.maxRetries ?? TASK_MAX_RETRIES;
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

// ─── Legacy pre-0.4 Paperclip compatibility surface ────────────────────────
// Kept as named exports for callers that adopted the package's earlier
// task-oriented adapter shape. The current package-root ServerAdapterModule is
// implemented in paperclip.ts.

/** Paperclip skill shape (subset of the canonical Paperclip Skill). */
export interface PaperclipSkill {
  id: string;
  name: string;
  description?: string;
}

/**
 * Detect a sensible default model/provider for the configured Agrenting agent.
 * Paperclip calls this to pre-populate the adapter UI when an agent is
 * created. Returns null if no info is available.
 */
export async function detectModel(
  config: Pick<AgrentingAdapterConfig, "agrentingUrl" | "apiKey" | "agentDid">
): Promise<{ provider: string; model: string } | null> {
  if (!config.agentDid) return null;
  try {
    const profile = await getAgentProfile(config as AgrentingAdapterConfig, config.agentDid);
    const provider = (profile as { ai_provider?: string }).ai_provider ?? null;
    const model = (profile as { ai_model?: string }).ai_model ?? null;
    if (provider && model) return { provider, model };
  } catch {
    // Surface as "no detection" rather than a hard error — Paperclip falls
    // back to user input.
  }
  return null;
}

/**
 * Enumerate the configured Agrenting agent's capabilities and map them to
 * Paperclip's Skill shape.
 */
export async function listSkills(
  config: AgrentingAdapterConfig
): Promise<PaperclipSkill[]> {
  const profile = await getAgentProfile(config, config.agentDid);
  const capabilities = profile.capabilities ?? [];
  return capabilities.map((cap) => ({
    id: `${config.agentDid}:${cap}`,
    name: cap,
    description: `Capability "${cap}" of agent ${config.agentDid}`,
  }));
}

/**
 * Reconcile the agent's current capabilities against Paperclip's local skill
 * registry. Returns sets to add and remove.
 */
export async function syncSkills(
  config: AgrentingAdapterConfig,
  existing: PaperclipSkill[]
): Promise<{ added: PaperclipSkill[]; removed: PaperclipSkill[] }> {
  const remote = await listSkills(config);
  const remoteIds = new Set(remote.map((s) => s.id));
  const existingIds = new Set(existing.map((s) => s.id));
  return {
    added: remote.filter((s) => !existingIds.has(s.id)),
    removed: existing.filter((s) => !remoteIds.has(s.id)),
  };
}

/**
 * Session codec — Paperclip uses this to serialise session state across
 * heartbeats. Hirings carry no rich session state, so we pass JSON through.
 */
export const sessionCodec = paperclipSessionCodec;

/**
 * Legacy `AgentAdapter.invoke`. Forwards to {@link execute}.
 */
export async function invoke(
  config: AgrentingAdapterConfig,
  params: {
    input: string;
    capability: string;
    instructions?: string;
    maxPrice?: string;
    paymentType?: string;
  }
): Promise<AgrentingExecutionResult> {
  return execute(config, params);
}

/**
 * Legacy `AgentAdapter.status`. Returns the current run status.
 */
export async function status(
  config: AgrentingAdapterConfig,
  taskId: string
): Promise<{
  status: AgrentingTaskStatus;
  progressPercent: number;
  progressMessage?: string;
}> {
  const progress = await getTaskProgress(config, taskId);
  return {
    status: progress.status,
    progressPercent: progress.progressPercent,
    progressMessage: progress.progressMessage,
  };
}

/**
 * Legacy `AgentAdapter.cancel`. Cancels a running task; throws on failure
 * so Paperclip can treat the call as a void Promise.
 */
export async function cancel(
  config: AgrentingAdapterConfig,
  taskId: string
): Promise<void> {
  const result = await cancelTask(config, taskId);
  if (!result.success) {
    throw new Error(result.error ?? "Failed to cancel task");
  }
}

/**
 * Create the server-side adapter module.
 * Paperclip plugin loaders call this factory from the package root. The
 * current ServerAdapterModule members are combined with explicitly named
 * compatibility helpers for pre-0.4 consumers.
 */
export function createServerAdapter() {
  const canonical = createCanonicalServerAdapter();
  return {
    ...canonical,
    name: "agrenting" as const,
    // Legacy helpers remain available under explicit names. The canonical
    // Paperclip keys above use AdapterExecutionContext and structured tests.
    legacyExecute: execute,
    legacyTestEnvironment: testEnvironment,
    getLegacyConfigSchema: getConfigSchema,
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
    cancelHiring,
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
    // Legacy pre-0.4 contract additions:
    invoke,
    status,
    cancel,
    legacyDetectModel: detectModel,
    legacyListSkills: listSkills,
    legacySyncSkills: syncSkills,
  };
}
