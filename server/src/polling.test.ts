import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pollTaskUntilDone,
  getBackoffMs,
  getWebhookGracePeriodMs,
  POLL_INTERVALS_MS,
  MAX_POLLS,
} from "./polling.js";

// Mock the client so we don't hit the real API
vi.mock("./client.js", () => {
  return {
    AgrentingClient: vi.fn().mockImplementation(function() {
      return {
        getTask: vi.fn().mockResolvedValue({
          id: "task-1",
          status: "completed",
          output: "done",
          client_agent_id: "c1",
          provider_agent_id: "p1",
          capability: "test",
          input: "hello",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      };
    }),
  };
});

const mockConfig = {
  agrentingUrl: "https://api.agrenting.com",
  apiKey: "test-key",
  agentDid: "did:agrenting:test",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getBackoffMs
// ---------------------------------------------------------------------------

describe("getBackoffMs", () => {
  it("returns 10s for attempt 0", () => {
    expect(getBackoffMs(0)).toBe(10_000);
  });

  it("returns 30s for attempt 1", () => {
    expect(getBackoffMs(1)).toBe(30_000);
  });

  it("returns 60s for attempt 2", () => {
    expect(getBackoffMs(2)).toBe(60_000);
  });

  it("returns 120s for attempt 3", () => {
    expect(getBackoffMs(3)).toBe(120_000);
  });

  it("caps at 120s for higher attempts", () => {
    expect(getBackoffMs(10)).toBe(120_000);
    expect(getBackoffMs(100)).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// POLL_INTERVALS_MS / MAX_POLLS constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("has 4 poll intervals with exponential backoff", () => {
    expect(POLL_INTERVALS_MS).toEqual([10_000, 30_000, 60_000, 120_000]);
  });

  it("MAX_POLLS is 10", () => {
    expect(MAX_POLLS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// getWebhookGracePeriodMs
// ---------------------------------------------------------------------------

describe("getWebhookGracePeriodMs", () => {
  it("returns 60s by default (10% of 600s, capped at 60s)", () => {
    expect(getWebhookGracePeriodMs(mockConfig)).toBe(60_000);
  });

  it("returns 10% of timeout for short timeouts", () => {
    const config = { ...mockConfig, timeoutSec: 30 };
    // 30s * 1000 * 0.1 = 3000ms, min(60000, 3000) = 3000
    expect(getWebhookGracePeriodMs(config)).toBe(3_000);
  });

  it("caps at 60s even for long timeouts", () => {
    const config = { ...mockConfig, timeoutSec: 3600 };
    // 3600s * 1000 * 0.1 = 360000, min(60000, 360000) = 60000
    expect(getWebhookGracePeriodMs(config)).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// pollTaskUntilDone
// ---------------------------------------------------------------------------

describe("pollTaskUntilDone", () => {
  it("returns completed task on first poll", { timeout: 30_000 }, async () => {
    const result = await pollTaskUntilDone({
      config: mockConfig,
      taskId: "task-1",
      deadline: Date.now() + 600_000,
    });

    expect(result.result.success).toBe(true);
    expect(result.result.output).toBe("done");
    expect(result.result.taskId).toBe("task-1");
    expect(result.viaPolling).toBe(true);
    expect(result.pollCount).toBeGreaterThanOrEqual(1);
  });

  it("returns timeout when deadline is in the past", async () => {
    const result = await pollTaskUntilDone({
      config: mockConfig,
      taskId: "task-1",
      deadline: Date.now() - 1000, // Already past
    });

    expect(result.result.success).toBe(false);
    expect(result.result.error).toContain("timed out");
    expect(result.pollCount).toBe(0);
  });

  it("fires onStatusUpdate callback on each poll", { timeout: 30_000 }, async () => {
    const onStatusUpdate = vi.fn();

    await pollTaskUntilDone({
      config: mockConfig,
      taskId: "task-1",
      deadline: Date.now() + 600_000,
      onStatusUpdate,
    });

    expect(onStatusUpdate).toHaveBeenCalledTimes(1);
    expect(onStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
      1
    );
  });

  it("reports failure when task fails", { timeout: 30_000 }, async () => {
    const { AgrentingClient } = await import("./client.js");
    const MockClient = vi.mocked(AgrentingClient);
    MockClient.mockImplementationOnce(function() {
      return {
        getTask: vi.fn().mockResolvedValue({
          id: "fail-task",
          status: "failed",
          error_reason: "Agent crashed",
          client_agent_id: "c1",
          provider_agent_id: "p1",
          capability: "test",
          input: "hello",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      };
    });

    const result = await pollTaskUntilDone({
      config: mockConfig,
      taskId: "fail-task",
      deadline: Date.now() + 600_000,
    });

    expect(result.result.success).toBe(false);
    expect(result.result.error).toBe("Agent crashed");
  });

  it("reports cancellation when task is cancelled", { timeout: 30_000 }, async () => {
    const { AgrentingClient } = await import("./client.js");
    const MockClient = vi.mocked(AgrentingClient);
    MockClient.mockImplementationOnce(function() {
      return {
        getTask: vi.fn().mockResolvedValue({
          id: "cancel-task",
          status: "cancelled",
          client_agent_id: "c1",
          provider_agent_id: "p1",
          capability: "test",
          input: "hello",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      };
    });

    const result = await pollTaskUntilDone({
      config: mockConfig,
      taskId: "cancel-task",
      deadline: Date.now() + 600_000,
    });

    expect(result.result.success).toBe(false);
    expect(result.result.error).toBe("Task was cancelled");
  });
});
