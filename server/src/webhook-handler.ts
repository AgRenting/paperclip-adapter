/**
 * Paperclip-side webhook handler for Agrenting task events.
 *
 * This module provides:
 * - An HTTP request handler that processes incoming webhook payloads from Agrenting
 * - Task ID to Paperclip issue ID mapping registry
 * - Automatic issue status updates and comment posting on task events
 *
 * Usage: Paperclip mounts this handler at `POST /api/webhooks/agrenting/:companyId`.
 * The handler receives raw body, headers, and a Paperclip API client to update issues.
 */

import type { IncomingHttpHeaders } from "http";
import type { AgrentingAdapterConfig } from "./types.js";
import { verifyWebhookSignature } from "./crypto.js";

// ---------------------------------------------------------------------------
// Task → Issue mapping registry
// ---------------------------------------------------------------------------

interface TaskMapping {
  issueId: string;
  companyId: string;
  config: AgrentingAdapterConfig;
  startedAt: number;
  status: string;
}

const taskRegistry = new Map<string, TaskMapping>();

const TASK_REGISTRY_TTL_MS = 2 * 60 * 60 * 1000; // 2h — max age before cleanup
const TASK_REGISTRY_CLEANUP_INTERVAL_MS = 60_000; // 60s sweep interval
let registryCleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sweep taskRegistry for entries older than the TTL.
 * Called periodically to bound memory growth if terminal events are lost.
 */
function sweepStaleRegistryEntries(): void {
  const now = Date.now();
  for (const [id, entry] of taskRegistry) {
    if (now - entry.startedAt > TASK_REGISTRY_TTL_MS) {
      taskRegistry.delete(id);
    }
  }
}

/**
 * Start the periodic registry cleanup timer.
 * Safe to call multiple times — only one timer runs at a time.
 */
export function startRegistryCleanup(): void {
  if (registryCleanupTimer) return;
  registryCleanupTimer = setInterval(sweepStaleRegistryEntries, TASK_REGISTRY_CLEANUP_INTERVAL_MS);
  registryCleanupTimer.unref();
}

/**
 * Stop the periodic registry cleanup timer.
 */
export function stopRegistryCleanup(): void {
  if (registryCleanupTimer) {
    clearInterval(registryCleanupTimer);
    registryCleanupTimer = null;
  }
}

/**
 * Register a mapping between an Agrenting task ID and a Paperclip issue.
 * Call this before executing a task so the webhook handler knows which issue to update.
 */
export function registerTaskMapping(
  taskId: string,
  issueId: string,
  companyId: string,
  config: AgrentingAdapterConfig
): void {
  taskRegistry.set(taskId, {
    issueId,
    companyId,
    config,
    startedAt: Date.now(),
    status: "pending",
  });
}

/**
 * Remove a task mapping from the registry.
 */
export function unregisterTaskMapping(taskId: string): void {
  taskRegistry.delete(taskId);
}

/**
 * Get all active task mappings.
 */
export function getActiveTaskMappings(): ReadonlyMap<string, TaskMapping> {
  return taskRegistry;
}

// ---------------------------------------------------------------------------
// Webhook payload types
// ---------------------------------------------------------------------------

export interface AgrentingWebhookPayload {
  task_id: string;
  status: string;
  output?: string;
  error_reason?: string;
  progress_percent?: number;
  progress_message?: string;
  completed_at?: string;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// Paperclip API client interface
// ---------------------------------------------------------------------------

export interface PaperclipApiClient {
  /** Update an issue's status and optionally post a comment */
  updateIssue(issueId: string, body: {
    status?: string;
    comment?: string;
  }): Promise<void>;

  /** Post a comment on an issue without changing status */
  postComment(issueId: string, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

interface EventHandlerContext {
  api: PaperclipApiClient;
  mapping: TaskMapping;
  payload: AgrentingWebhookPayload;
}

const eventHandlers: Record<
  string,
  (ctx: EventHandlerContext) => Promise<void>
> = {
  "task.created": async (ctx) => {
    ctx.mapping.status = "pending";
    await ctx.api.postComment(
      ctx.mapping.issueId,
      `**Agrenting task created** — Task \`${ctx.payload.task_id}\` submitted and awaiting claim.`
    );
  },

  "task.claimed": async (ctx) => {
    ctx.mapping.status = "claimed";
    await ctx.api.postComment(
      ctx.mapping.issueId,
      `**Agrenting task claimed** — An agent has picked up the task and is preparing to work.`
    );
  },

  "task.in_progress": async (ctx) => {
    ctx.mapping.status = "in_progress";
    const progress = ctx.payload.progress_percent
      ? ` (${ctx.payload.progress_percent}%)`
      : "";
    const message = ctx.payload.progress_message
      ? ` — ${ctx.payload.progress_message}`
      : "";
    await ctx.api.postComment(
      ctx.mapping.issueId,
      `**Task in progress**${progress}${message}`
    );
  },

  "task.completed": async (ctx) => {
    ctx.mapping.status = "completed";
    const duration = ((Date.now() - ctx.mapping.startedAt) / 1000).toFixed(1);
    await ctx.api.updateIssue(ctx.mapping.issueId, {
      status: "done",
      comment: `**Agrenting task completed** — Task \`${ctx.payload.task_id}\` finished in ${duration}s.${
        ctx.payload.output ? `\n\n### Output\n\n${ctx.payload.output}` : ""
      }`,
    });
    unregisterTaskMapping(ctx.payload.task_id);
  },

  "task.failed": async (ctx) => {
    ctx.mapping.status = "failed";
    await ctx.api.updateIssue(ctx.mapping.issueId, {
      status: "blocked",
      comment: `**Agrenting task failed** — Task \`${ctx.payload.task_id}\` encountered an error.\n\n**Error:** ${ctx.payload.error_reason ?? "No error reason provided."}`,
    });
    unregisterTaskMapping(ctx.payload.task_id);
  },

  "task.cancelled": async (ctx) => {
    ctx.mapping.status = "cancelled";
    await ctx.api.updateIssue(ctx.mapping.issueId, {
      status: "cancelled",
      comment: `**Agrenting task cancelled** — Task \`${ctx.payload.task_id}\` was cancelled.`,
    });
    unregisterTaskMapping(ctx.payload.task_id);
  },
};

// ---------------------------------------------------------------------------
// Webhook handler factory
// ---------------------------------------------------------------------------

export interface WebhookHandlerOptions {
  /** Secret used to verify HMAC signatures */
  webhookSecret: string;
  /** Paperclip API client for updating issues */
  api: PaperclipApiClient;
  /** Optional: handle unknown event types */
  onUnknownEvent?: (event: string, payload: AgrentingWebhookPayload) => void;
}

/**
 * Create a webhook handler function suitable for mounting in an HTTP server.
 *
 * The returned handler expects `(rawBody, headers)` and returns a Promise
 * resolving to `{ status, body, headers }` for the HTTP response.
 *
 * This design is framework-agnostic: Paperclip can wrap it in Express,
 * Fastify, or a raw Node.js http server.
 */
export function createWebhookHandler(options: WebhookHandlerOptions) {
  startRegistryCleanup();
  return async function handleWebhookRequest(
    rawBody: string,
    headers: IncomingHttpHeaders
  ): Promise<{ status: number; body: string; headers?: Record<string, string> }> {
    const signature =
      (headers["x-webhook-signature"] as string) ??
      (headers["X-Webhook-Signature"] as string) ??
      "";
    const eventType =
      (headers["x-webhook-event"] as string) ??
      (headers["X-Webhook-Event"] as string) ??
      "";

    // Parse payload
    let payload: AgrentingWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: "Invalid JSON" };
    }

    // Verify signature
    const valid = await verifyWebhookSignature(
      rawBody,
      signature,
      options.webhookSecret
    );
    if (!valid) {
      return { status: 401, body: "Invalid signature" };
    }

    // Look up task mapping
    const taskId = payload.task_id;
    if (!taskId) {
      return { status: 400, body: "Missing task_id in payload" };
    }

    const mapping = taskRegistry.get(taskId);
    if (!mapping) {
      // Webhook received but no active mapping — task may have been handled
      // by the in-process listener already, or the mapping was cleaned up.
      return { status: 200, body: "OK (no active mapping)" };
    }

    // Dispatch to event handler
    const handler = eventHandlers[eventType];
    if (handler) {
      try {
        await handler({ api: options.api, mapping, payload });
      } catch (err) {
        console.error("[adapter-agrenting] Webhook handler error:", err);
        return {
          status: 500,
          body: "Internal error",
        };
      }
    } else {
      options.onUnknownEvent?.(eventType, payload);
    }

    return { status: 200, body: "OK" };
  };
}
