import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgrentingClient } from "./client.js";
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

afterEach(() => {
  vi.useRealTimers();
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
  for (const boundary of ["deadline", "abort"] as const) {
    it(`does not read a resumed max-poll task after ${boundary}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const controller = new AbortController();
      if (boundary === "abort") controller.abort();
      const getTask = vi.fn().mockResolvedValue({
        id: "task-resumed", status: "in_progress", client_agent_id: "c1",
        provider_agent_id: "p1", capability: "test", input: "hello",
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
      });
      vi.mocked(AgrentingClient).mockImplementationOnce(function() {
        return { getTask };
      });

      const result = await pollTaskUntilDone({
        config: mockConfig,
        taskId: "task-resumed",
        startAttempt: MAX_POLLS,
        deadline: Date.now() + (boundary === "deadline" ? 0 : 600_000),
        signal: controller.signal,
      });

      expect(getTask).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        result: {
          success: false,
          taskId: "task-resumed",
          error: boundary === "abort" ? "Polling aborted" : "Task timed out after 600s",
        },
        pollCount: MAX_POLLS,
      });
    });
  }

  it("retains the final reconciliation read while the deadline and signal permit it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const getTask = vi.fn().mockResolvedValue({ id: "task-final", status: "completed", output: "done" });
    vi.mocked(AgrentingClient).mockImplementationOnce(function() {
      return { getTask };
    });

    const result = await pollTaskUntilDone({
      config: mockConfig,
      taskId: "task-final",
      startAttempt: MAX_POLLS,
      deadline: Date.now() + 600_000,
      signal: new AbortController().signal,
    });

    expect(getTask).toHaveBeenCalledExactlyOnceWith("task-final");
    expect(result).toMatchObject({
      result: { success: true, taskId: "task-final", output: "done" },
      pollCount: MAX_POLLS + 1,
    });
  });

  for (const boundary of ["deadline", "abort"] as const) {
    it(`does not make the final read when ${boundary} occurs on the last poll`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const controller = new AbortController();
      const deadline = Date.now() + 200_000;
      const getTask = vi.fn();
      vi.mocked(AgrentingClient).mockImplementationOnce(function() {
        return { getTask };
      });
      getTask.mockImplementation(async () => {
        if (boundary === "deadline") vi.setSystemTime(deadline);
        else controller.abort();
        return {
          id: "task-last", status: "in_progress", client_agent_id: "c1",
          provider_agent_id: "p1", capability: "test", input: "hello",
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        };
      });
      const running = pollTaskUntilDone({
        config: mockConfig, taskId: "task-last", startAttempt: MAX_POLLS - 1,
        deadline, signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await running;
      expect(getTask).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        result: { success: false, taskId: "task-last", error: boundary === "abort" ? "Polling aborted" : "Task timed out after 600s" },
        pollCount: MAX_POLLS,
      });
    });
  }

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

 it("does not start a task read when aborted during polling backoff", async () => {
  const controller = new AbortController();
  const running = pollTaskUntilDone({ config: mockConfig, taskId: "task-1", startAttempt: 1, deadline: Date.now() + 600000, signal: controller.signal });
  controller.abort();
  const result = await running;
  expect(result.result).toMatchObject({ success: false, error: "Polling aborted" });
});
