import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWebhookHandler,
  registerTaskMapping,
  unregisterTaskMapping,
  getActiveTaskMappings,
  stopRegistryCleanup,
} from "./webhook-handler.js";
import type { PaperclipApiClient } from "./webhook-handler.js";
import type { AgrentingAdapterConfig } from "./types.js";

// We need to mock the crypto module so verifyWebhookSignature returns true
vi.mock("./crypto.js", () => ({
  verifyWebhookSignature: vi.fn().mockResolvedValue(true),
}));

const mockConfig: AgrentingAdapterConfig = {
  agrentingUrl: "https://api.agrenting.com",
  apiKey: "test-key",
  agentDid: "did:agrenting:test",
};

function mockApi(): PaperclipApiClient & {
  updateIssue: ReturnType<typeof vi.fn>;
  postComment: ReturnType<typeof vi.fn>;
} {
  return {
    updateIssue: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the task registry between tests
  const mappings = getActiveTaskMappings();
  for (const key of mappings.keys()) {
    unregisterTaskMapping(key);
  }
  stopRegistryCleanup();
});

// ---------------------------------------------------------------------------
// Task registry
// ---------------------------------------------------------------------------

describe("task registry", () => {
  it("registers and retrieves a task mapping", () => {
    registerTaskMapping("task-1", "issue-1", "company-1", mockConfig);
    const mappings = getActiveTaskMappings();
    expect(mappings.has("task-1")).toBe(true);
    const entry = mappings.get("task-1")!;
    expect(entry.issueId).toBe("issue-1");
    expect(entry.companyId).toBe("company-1");
    expect(entry.status).toBe("pending");
  });

  it("unregisters a task mapping", () => {
    registerTaskMapping("task-2", "issue-2", "company-1", mockConfig);
    unregisterTaskMapping("task-2");
    expect(getActiveTaskMappings().has("task-2")).toBe(false);
  });

  it("returns a ReadonlyMap", () => {
    registerTaskMapping("task-3", "issue-3", "company-1", mockConfig);
    const mappings = getActiveTaskMappings();
    expect(mappings).toBeInstanceOf(Map);
    expect(mappings.size).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

describe("createWebhookHandler", () => {
  it("returns 400 for invalid JSON body", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    const result = await handler("not-json", {
      "x-webhook-signature": "sig",
      "x-webhook-event": "task.completed",
    });

    expect(result.status).toBe(400);
    expect(result.body).toBe("Invalid JSON");
  });

  it("returns 401 when signature is invalid", async () => {
    const { verifyWebhookSignature } = await import("./crypto.js");
    (verifyWebhookSignature as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    const result = await handler(
      JSON.stringify({ task_id: "t1", status: "completed" }),
      { "x-webhook-signature": "bad-sig", "x-webhook-event": "task.completed" }
    );

    expect(result.status).toBe(401);
    expect(result.body).toBe("Invalid signature");
  });

  it("returns 400 when task_id is missing", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    const result = await handler(
      JSON.stringify({ status: "completed" }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.completed" }
    );

    expect(result.status).toBe(400);
    expect(result.body).toBe("Missing task_id in payload");
  });

  it("returns 200 with no active mapping for unknown task_id", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    const result = await handler(
      JSON.stringify({ task_id: "unknown-task", status: "completed" }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.completed" }
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe("OK (no active mapping)");
    expect(api.updateIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

describe("event handling", () => {
  it("handles task.created event", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    registerTaskMapping("task-created", "issue-created", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({ task_id: "task-created", status: "pending" }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.created" }
    );

    expect(result.status).toBe(200);
    expect(api.postComment).toHaveBeenCalledWith(
      "issue-created",
      expect.stringContaining("task created")
    );
  });

  it("handles task.claimed event", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    registerTaskMapping("task-claimed", "issue-claimed", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({ task_id: "task-claimed", status: "claimed" }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.claimed" }
    );

    expect(result.status).toBe(200);
    expect(api.postComment).toHaveBeenCalledWith(
      "issue-claimed",
      expect.stringContaining("claimed")
    );
  });

  it("handles task.in_progress event with progress", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    registerTaskMapping("task-progress", "issue-progress", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({
        task_id: "task-progress",
        status: "in_progress",
        progress_percent: 50,
        progress_message: "Halfway there",
      }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.in_progress" }
    );

    expect(result.status).toBe(200);
    expect(api.postComment).toHaveBeenCalledWith(
      "issue-progress",
      expect.stringContaining("50%")
    );
    expect(api.postComment).toHaveBeenCalledWith(
      "issue-progress",
      expect.stringContaining("Halfway there")
    );
  });

  it("handles task.completed event", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    registerTaskMapping("task-done", "issue-done", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({
        task_id: "task-done",
        status: "completed",
        output: "All done!",
      }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.completed" }
    );

    expect(result.status).toBe(200);
    expect(api.updateIssue).toHaveBeenCalledWith("issue-done", {
      status: "done",
      comment: expect.stringContaining("All done!"),
    });
    // Task should be unregistered after completion
    expect(getActiveTaskMappings().has("task-done")).toBe(false);
  });

  it("handles task.failed event", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    registerTaskMapping("task-fail", "issue-fail", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({
        task_id: "task-fail",
        status: "failed",
        error_reason: "Something broke",
      }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.failed" }
    );

    expect(result.status).toBe(200);
    expect(api.updateIssue).toHaveBeenCalledWith("issue-fail", {
      status: "blocked",
      comment: expect.stringContaining("Something broke"),
    });
    expect(getActiveTaskMappings().has("task-fail")).toBe(false);
  });

  it("handles task.cancelled event", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    registerTaskMapping("task-cancel", "issue-cancel", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({ task_id: "task-cancel", status: "cancelled" }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.cancelled" }
    );

    expect(result.status).toBe(200);
    expect(api.updateIssue).toHaveBeenCalledWith("issue-cancel", {
      status: "cancelled",
      comment: expect.stringContaining("cancelled"),
    });
    expect(getActiveTaskMappings().has("task-cancel")).toBe(false);
  });

  it("calls onUnknownEvent for unrecognized event types", async () => {
    const api = mockApi();
    const onUnknownEvent = vi.fn();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
      onUnknownEvent,
    });

    registerTaskMapping("task-unknown", "issue-unknown", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({ task_id: "task-unknown", status: "custom" }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.custom_event" }
    );

    expect(result.status).toBe(200);
    expect(onUnknownEvent).toHaveBeenCalledWith(
      "task.custom_event",
      expect.objectContaining({ task_id: "task-unknown" })
    );
  });

  it("returns 500 when event handler throws", async () => {
    const api = mockApi();
    api.postComment.mockRejectedValueOnce(new Error("API down"));
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    registerTaskMapping("task-err", "issue-err", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({ task_id: "task-err", status: "pending" }),
      { "x-webhook-signature": "sig", "x-webhook-event": "task.created" }
    );

    expect(result.status).toBe(500);
    expect(result.body).toBe("Internal error");
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive header handling
// ---------------------------------------------------------------------------

describe("header handling", () => {
  it("reads signature from X-Webhook-Signature (capitalized)", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    const result = await handler(
      JSON.stringify({ task_id: "t1", status: "completed" }),
      { "X-Webhook-Signature": "sig", "X-Webhook-Event": "task.completed" }
    );

    // Should get past signature check (not 401)
    expect(result.status).not.toBe(401);
  });

  it("reads event from X-Webhook-Event (capitalized)", async () => {
    const api = mockApi();
    const handler = createWebhookHandler({
      webhookSecret: "secret",
      api,
    });

    registerTaskMapping("t2", "i2", "c1", mockConfig);

    const result = await handler(
      JSON.stringify({ task_id: "t2", status: "pending" }),
      { "x-webhook-signature": "sig", "X-Webhook-Event": "task.created" }
    );

    expect(result.status).toBe(200);
    expect(api.postComment).toHaveBeenCalled();
  });
});
