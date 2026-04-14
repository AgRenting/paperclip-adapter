import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createServerAdapter,
  getConfigSchema,
  testEnvironment,
  execute,
  cancelTask,
  discoverAgents,
  getBalance,
  getTransactions,
  getTaskPayment,
  getTaskProgress,
} from "./adapter.js";
import { unregisterTaskMapping, getActiveTaskMappings, stopRegistryCleanup } from "./webhook-handler.js";
import type { AgrentingAdapterConfig } from "./types.js";

// Mock the client so we don't hit the real API
vi.mock("./client.js", () => {
  return {
    AgrentingClient: vi.fn().mockImplementation(function() {
      return {
        testConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected" }),
        createTask: vi.fn().mockResolvedValue({
          id: "mock-task-id",
          status: "pending",
          client_agent_id: "c1",
          provider_agent_id: "did:agrenting:test",
          capability: "test",
          input: "hello",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        getTask: vi.fn().mockResolvedValue({
          id: "mock-task-id",
          status: "completed",
          client_agent_id: "c1",
          provider_agent_id: "did:agrenting:test",
          capability: "test",
          input: "hello",
          output: "task output",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        getTaskProgress: vi.fn().mockResolvedValue({
          status: "completed",
          progress_percent: 100,
          progress_message: "Done",
          updated_at: new Date().toISOString(),
        }),
        getTaskTimeline: vi.fn().mockResolvedValue({ events: [] }),
        cancelTask: vi.fn().mockResolvedValue({ id: "mock-task-id", status: "cancelled" }),
        discoverAgents: vi.fn().mockResolvedValue([{ id: "agent-1", name: "Agent" }]),
        getBalance: vi.fn().mockResolvedValue({ available: "100", escrow: "0", total: "100" }),
        getTransactions: vi.fn().mockResolvedValue([]),
        getTaskPayment: vi.fn().mockResolvedValue({
          id: "pay-1", task_id: "mock-task-id", amount: "10", currency: "USD",
          status: "escrowed", created_at: new Date().toISOString(),
        }),
        createTaskPayment: vi.fn().mockResolvedValue({
          id: "pay-1", task_id: "mock-task-id", amount: "10", currency: "USD",
          status: "escrowed", created_at: new Date().toISOString(),
        }),
        deleteWebhook: vi.fn().mockResolvedValue(undefined),
        uploadDocument: vi.fn().mockResolvedValue({
          id: "doc-1", name: "instructions", file_url: "https://cdn/doc",
          content_type: "text/plain", file_hash: "hash", document_type: "instructions",
        }),
      };
    }),
  };
});

// Mock balance-monitor to avoid API calls
vi.mock("./balance-monitor.js", () => ({
  canSubmitTask: vi.fn().mockResolvedValue({ ok: true }),
  checkBalance: vi.fn().mockResolvedValue({
    available: 100, escrow: 0, total: 100,
    currency: "USD", isLow: false, isInsufficient: false,
  }),
  formatLowBalanceComment: vi.fn().mockReturnValue("Low balance"),
  formatInsufficientBalanceComment: vi.fn().mockReturnValue("Insufficient"),
}));

// Mock webhook listener
vi.mock("./webhook-handler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webhook-handler.js")>();
  return {
    ...actual,
  };
});

const mockConfig: AgrentingAdapterConfig = {
  agrentingUrl: "https://api.agrenting.com",
  apiKey: "test-key",
  agentDid: "did:agrenting:test",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Clear task registry
  const mappings = getActiveTaskMappings();
  for (const key of mappings.keys()) {
    unregisterTaskMapping(key);
  }
  stopRegistryCleanup();
});

// ---------------------------------------------------------------------------
// createServerAdapter
// ---------------------------------------------------------------------------

describe("createServerAdapter", () => {
  it("returns adapter with name 'agrenting'", () => {
    const adapter = createServerAdapter();
    expect(adapter.name).toBe("agrenting");
  });

  it("exposes all required methods", () => {
    const adapter = createServerAdapter();
    const methods = [
      "execute",
      "testEnvironment",
      "getConfigSchema",
      "startWebhookListener",
      "stopWebhookListener",
      "registerWebhook",
      "deregisterWebhook",
      "getTaskProgress",
      "getTaskPayment",
      "cancelTask",
      "discoverAgents",
      "getBalance",
      "getTransactions",
      "deposit",
      "withdraw",
    ];
    for (const method of methods) {
      expect(typeof (adapter as Record<string, unknown>)[method]).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// getConfigSchema
// ---------------------------------------------------------------------------

describe("getConfigSchema", () => {
  it("returns a valid JSON schema with required fields", () => {
    const schema = getConfigSchema();
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["agrentingUrl", "apiKey", "agentDid"]);
  });

  it("includes all config properties", () => {
    const schema = getConfigSchema();
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("agrentingUrl");
    expect(props).toHaveProperty("apiKey");
    expect(props).toHaveProperty("agentDid");
    expect(props).toHaveProperty("webhookSecret");
    expect(props).toHaveProperty("webhookCallbackUrl");
    expect(props).toHaveProperty("pricingModel");
    expect(props).toHaveProperty("timeoutSec");
    expect(props).toHaveProperty("instructionsBundleMode");
  });

  it("marks apiKey and webhookSecret as sensitive", () => {
    const schema = getConfigSchema();
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.apiKey.sensitive).toBe(true);
    expect(props.webhookSecret.sensitive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// testEnvironment
// ---------------------------------------------------------------------------

describe("testEnvironment", () => {
  it("returns ok when connection succeeds", async () => {
    const result = await testEnvironment(mockConfig);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// execute (polling mode — no webhook config)
// ---------------------------------------------------------------------------

describe("execute", () => {
  it("executes a task in polling mode and returns success", async () => {
    const result = await execute(mockConfig, {
      input: "test input",
      capability: "test-capability",
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBe("mock-task-id");
    expect(result.output).toBe("task output");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error when task fails", async () => {
    const { AgrentingClient } = await import("./client.js");
    const MockClient = vi.mocked(AgrentingClient);
    // Both execute() and pollTaskUntilDone() create an AgrentingClient,
    // so mock twice (once for each construction).
    MockClient.mockImplementationOnce(function() {
      return {
        testConnection: vi.fn(),
        createTask: vi.fn().mockResolvedValue({
          id: "fail-task",
          status: "pending",
          client_agent_id: "c1",
          provider_agent_id: "p1",
          capability: "test",
          input: "hello",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        getTask: vi.fn(),
        getTaskProgress: vi.fn(),
        getTaskTimeline: vi.fn(),
        cancelTask: vi.fn(),
        discoverAgents: vi.fn(),
        getBalance: vi.fn(),
        getTransactions: vi.fn(),
        getTaskPayment: vi.fn(),
        createTaskPayment: vi.fn(),
        deleteWebhook: vi.fn(),
        uploadDocument: vi.fn(),
      };
    });
    MockClient.mockImplementationOnce(function() {
      return {
        testConnection: vi.fn(),
        createTask: vi.fn(),
        getTask: vi.fn().mockResolvedValue({
          id: "fail-task",
          status: "failed",
          error_reason: "Something went wrong",
          client_agent_id: "c1",
          provider_agent_id: "p1",
          capability: "test",
          input: "hello",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        getTaskProgress: vi.fn(),
        getTaskTimeline: vi.fn(),
        cancelTask: vi.fn(),
        discoverAgents: vi.fn(),
        getBalance: vi.fn(),
        getTransactions: vi.fn(),
        getTaskPayment: vi.fn(),
        createTaskPayment: vi.fn(),
        deleteWebhook: vi.fn(),
        uploadDocument: vi.fn(),
      };
    });

    const result = await execute(mockConfig, {
      input: "test",
      capability: "test",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Something went wrong");
  });

  it("returns error when task is cancelled", async () => {
    const { AgrentingClient } = await import("./client.js");
    const MockClient = vi.mocked(AgrentingClient);
    MockClient.mockImplementationOnce(function() {
      return {
        testConnection: vi.fn(),
        createTask: vi.fn().mockResolvedValue({
          id: "cancel-task",
          status: "pending",
          client_agent_id: "c1",
          provider_agent_id: "p1",
          capability: "test",
          input: "hello",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        getTask: vi.fn(),
        getTaskProgress: vi.fn(),
        getTaskTimeline: vi.fn(),
        cancelTask: vi.fn(),
        discoverAgents: vi.fn(),
        getBalance: vi.fn(),
        getTransactions: vi.fn(),
        getTaskPayment: vi.fn(),
        createTaskPayment: vi.fn(),
        deleteWebhook: vi.fn(),
        uploadDocument: vi.fn(),
      };
    });
    MockClient.mockImplementationOnce(function() {
      return {
        testConnection: vi.fn(),
        createTask: vi.fn(),
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
        getTaskProgress: vi.fn(),
        getTaskTimeline: vi.fn(),
        cancelTask: vi.fn(),
        discoverAgents: vi.fn(),
        getBalance: vi.fn(),
        getTransactions: vi.fn(),
        getTaskPayment: vi.fn(),
        createTaskPayment: vi.fn(),
        deleteWebhook: vi.fn(),
        uploadDocument: vi.fn(),
      };
    });

    const result = await execute(mockConfig, {
      input: "test",
      capability: "test",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Task was cancelled");
  });

  it("handles escrow payment failure by cancelling the task", async () => {
    const { AgrentingClient } = await import("./client.js");
    const mockCancel = vi.fn().mockResolvedValue({ id: "pay-fail-task", status: "cancelled" });
    const MockClient = vi.mocked(AgrentingClient);
    MockClient.mockImplementationOnce(function() {
      return {
        testConnection: vi.fn(),
        createTask: vi.fn().mockResolvedValue({
          id: "pay-fail-task",
          status: "pending",
          client_agent_id: "c1",
          provider_agent_id: "p1",
          capability: "test",
          input: "hello",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        getTask: vi.fn(),
        getTaskProgress: vi.fn(),
        getTaskTimeline: vi.fn(),
        cancelTask: mockCancel,
        discoverAgents: vi.fn(),
        getBalance: vi.fn(),
        getTransactions: vi.fn(),
        getTaskPayment: vi.fn(),
        createTaskPayment: vi.fn().mockRejectedValue(new Error("Insufficient funds")),
        deleteWebhook: vi.fn(),
        uploadDocument: vi.fn(),
      };
    });

    const result = await execute(mockConfig, {
      input: "test",
      capability: "test",
      maxPrice: "50.00",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Escrow payment failed");
    expect(mockCancel).toHaveBeenCalledWith("pay-fail-task");
  });
});

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

describe("cancelTask", () => {
  it("returns success when cancellation works", async () => {
    const result = await cancelTask(mockConfig, "task-1");
    expect(result.success).toBe(true);
  });

  it("returns error when cancellation fails", async () => {
    const { AgrentingClient } = await import("./client.js");
    const MockClient = vi.mocked(AgrentingClient);
    MockClient.mockImplementationOnce(function() {
      return {
        testConnection: vi.fn(),
        createTask: vi.fn(),
        getTask: vi.fn(),
        getTaskProgress: vi.fn(),
        getTaskTimeline: vi.fn(),
        cancelTask: vi.fn().mockRejectedValue(new Error("Cannot cancel")),
        discoverAgents: vi.fn(),
        getBalance: vi.fn(),
        getTransactions: vi.fn(),
        getTaskPayment: vi.fn(),
        createTaskPayment: vi.fn(),
        deleteWebhook: vi.fn(),
        uploadDocument: vi.fn(),
      };
    });

    const result = await cancelTask(mockConfig, "task-1");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Cannot cancel");
  });
});

// ---------------------------------------------------------------------------
// discoverAgents
// ---------------------------------------------------------------------------

describe("discoverAgents", () => {
  it("returns agents from the API", async () => {
    const result = await discoverAgents(mockConfig, { capability: "code-review" });
    expect(result).toEqual([{ id: "agent-1", name: "Agent" }]);
  });
});

// ---------------------------------------------------------------------------
// getBalance
// ---------------------------------------------------------------------------

describe("getBalance", () => {
  it("returns balance from the API", async () => {
    const result = await getBalance(mockConfig);
    expect(result.available).toBe("100");
  });
});

// ---------------------------------------------------------------------------
// getTransactions
// ---------------------------------------------------------------------------

describe("getTransactions", () => {
  it("returns transactions from the API", async () => {
    const result = await getTransactions(mockConfig);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getTaskPayment
// ---------------------------------------------------------------------------

describe("getTaskPayment", () => {
  it("returns payment info when found", async () => {
    const result = await getTaskPayment(mockConfig, "task-1");
    expect(result).toBeDefined();
    expect(result!.id).toBe("pay-1");
  });

  it("returns undefined when API throws", async () => {
    const { AgrentingClient } = await import("./client.js");
    const MockClient = vi.mocked(AgrentingClient);
    MockClient.mockImplementationOnce(function() {
      return {
        testConnection: vi.fn(),
        createTask: vi.fn(),
        getTask: vi.fn(),
        getTaskProgress: vi.fn(),
        getTaskTimeline: vi.fn(),
        cancelTask: vi.fn(),
        discoverAgents: vi.fn(),
        getBalance: vi.fn(),
        getTransactions: vi.fn(),
        getTaskPayment: vi.fn().mockRejectedValue(new Error("Not found")),
        createTaskPayment: vi.fn(),
        deleteWebhook: vi.fn(),
        uploadDocument: vi.fn(),
      };
    });

    const result = await getTaskPayment(mockConfig, "nonexistent");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getTaskProgress
// ---------------------------------------------------------------------------

describe("getTaskProgress", () => {
  it("returns progress and timeline", async () => {
    const result = await getTaskProgress(mockConfig, "task-1");
    expect(result.status).toBe("completed");
    expect(result.progressPercent).toBe(100);
    expect(result.timeline).toEqual([]);
  });
});
