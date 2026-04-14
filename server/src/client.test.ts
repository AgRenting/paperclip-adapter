import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgrentingClient } from "./client.js";

const mockConfig = {
  agrentingUrl: "https://api.agrenting.com",
  apiKey: "test-api-key",
  agentDid: "did:agrenting:test-agent",
};

function mockFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Constructor & headers
// ---------------------------------------------------------------------------

describe("AgrentingClient", () => {
  it("strips trailing slashes from baseUrl", () => {
    const client = new AgrentingClient({
      ...mockConfig,
      agrentingUrl: "https://api.agrenting.com///",
    });
    // Access via request — verify the URL is normalized
    mockFetchResponse(200, { data: { id: "1" } });
    void client.getTask("1");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.agrenting.com/api/v1/tasks/1",
      expect.anything()
    );
  });

  it("sends Content-Type and API key headers", () => {
    const client = new AgrentingClient(mockConfig);
    mockFetchResponse(200, { data: { id: "1" } });
    void client.getTask("1");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "test-api-key",
        },
      })
    );
  });

  // -------------------------------------------------------------------------
  // createTask
  // -------------------------------------------------------------------------

  describe("createTask", () => {
    it("sends POST to /api/v1/tasks with correct body", async () => {
      const client = new AgrentingClient(mockConfig);
      const taskData = {
        id: "task-123",
        status: "pending",
        client_agent_id: "client-1",
        provider_agent_id: "did:agrenting:test-agent",
        capability: "code-review",
        input: "review this code",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      };
      mockFetchResponse(200, { data: taskData });

      const result = await client.createTask({
        providerAgentId: "did:agrenting:test-agent",
        capability: "code-review",
        input: "review this code",
      });

      expect(result).toEqual(taskData);
      // Verify task response uses `id` field (not `task_id`)
      expect(result.id).toBe("task-123");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/tasks",
        expect.objectContaining({ method: "POST" })
      );
      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.provider_agent_id).toBe("did:agrenting:test-agent");
      expect(body.input).toBe("review this code");
    });

    it("includes max_price when provided", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, { data: { id: "1" } });

      await client.createTask({
        providerAgentId: "did:agrenting:test-agent",
        capability: "code-review",
        input: "review",
        maxPrice: "50.00",
      });

      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.max_price).toBe("50.00");
    });
  });

  // -------------------------------------------------------------------------
  // getTask
  // -------------------------------------------------------------------------

  describe("getTask", () => {
    it("fetches task by ID", async () => {
      const client = new AgrentingClient(mockConfig);
      const taskData = {
        id: "task-456",
        status: "completed",
        client_agent_id: "c1",
        provider_agent_id: "p1",
        capability: "test",
        input: "hello",
        output: "world",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      };
      mockFetchResponse(200, { data: taskData });

      const result = await client.getTask("task-456");
      expect(result).toEqual(taskData);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/tasks/task-456",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // cancelTask
  // -------------------------------------------------------------------------

  describe("cancelTask", () => {
    it("POSTs to cancel endpoint and returns cancelled task", async () => {
      const client = new AgrentingClient(mockConfig);
      const cancelledTask = {
        id: "t1",
        status: "cancelled",
        client_agent_id: "c1",
        provider_agent_id: "p1",
        capability: "test",
        input: "hello",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      };
      mockFetchResponse(200, { data: cancelledTask });

      const result = await client.cancelTask("t1");
      expect(result.id).toBe("t1");
      expect(result.status).toBe("cancelled");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/tasks/t1/cancel",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // getTaskTimeline
  // -------------------------------------------------------------------------

  describe("getTaskTimeline", () => {
    it("fetches timeline events for a task", async () => {
      const client = new AgrentingClient(mockConfig);
      const timelineData = {
        events: [
          { event_type: "task.created", timestamp: "2025-01-01T00:00:00Z" },
          { event_type: "task.claimed", timestamp: "2025-01-01T00:01:00Z" },
          { event_type: "task.completed", timestamp: "2025-01-01T00:05:00Z", progress_percent: 100, progress_message: "Done" },
        ],
      };
      mockFetchResponse(200, { data: timelineData });

      const result = await client.getTaskTimeline("task-456");
      expect(result.events).toHaveLength(3);
      expect(result.events[0].event_type).toBe("task.created");
      expect(result.events[2].progress_percent).toBe(100);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/tasks/task-456/timeline",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // getTaskAttempts
  // -------------------------------------------------------------------------

  describe("getTaskAttempts", () => {
    it("fetches attempt history for a task", async () => {
      const client = new AgrentingClient(mockConfig);
      const attemptsData = {
        attempts: [
          { id: "att-1", status: "failed", created_at: "2025-01-01T00:00:00Z", completed_at: "2025-01-01T00:02:00Z", error_reason: "Timeout" },
          { id: "att-2", status: "completed", created_at: "2025-01-01T00:03:00Z", completed_at: "2025-01-01T00:05:00Z" },
        ],
      };
      mockFetchResponse(200, { data: attemptsData });

      const result = await client.getTaskAttempts("task-789");
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].error_reason).toBe("Timeout");
      expect(result.attempts[1].status).toBe("completed");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/tasks/task-789/attempts",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // getBalance
  // -------------------------------------------------------------------------

  describe("getBalance", () => {
    it("fetches balance from ledger endpoint with full shape", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: { available: "100", escrow: "10", total: "110", currency: "USD" },
      });

      const result = await client.getBalance();
      expect(result.available).toBe("100");
      expect(result.escrow).toBe("10");
      expect(result.total).toBe("110");
      expect(result.currency).toBe("USD");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/ledger/balance",
        expect.anything()
      );
    });
  });

  // -------------------------------------------------------------------------
  // discoverAgents
  // -------------------------------------------------------------------------

  describe("discoverAgents", () => {
    it("sends query params for filters", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: [{ id: "agent-1", name: "Test Agent" }],
      });

      const result = await client.discoverAgents({
        capability: "code-review",
        minPrice: 10,
        maxPrice: 50,
        minReputation: 4,
        sortBy: "price",
        limit: 5,
      });

      expect(result).toEqual([{ id: "agent-1", name: "Test Agent" }]);
      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("capability=code-review");
      expect(url).toContain("min_price=10");
      expect(url).toContain("max_price=50");
      expect(url).toContain("limit=5");
    });

    it("works with no options", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, { data: [] });

      const result = await client.discoverAgents();
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // createTaskPayment
  // -------------------------------------------------------------------------

  describe("createTaskPayment", () => {
    it("creates payment for a task", async () => {
      const client = new AgrentingClient(mockConfig);
      const paymentData = {
        id: "pay-1",
        task_id: "t1",
        amount: "25.00",
        currency: "USD",
        status: "escrowed",
        created_at: "2025-01-01T00:00:00Z",
      };
      mockFetchResponse(200, { data: paymentData });

      const result = await client.createTaskPayment("t1", {
        paymentType: "escrow",
      });

      expect(result).toEqual(paymentData);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/tasks/t1/payments",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // registerWebhook / listWebhooks / deleteWebhook
  // -------------------------------------------------------------------------

  describe("webhook operations", () => {
    it("registers a webhook with flat request body", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          id: "wh-1",
          callback_url: "https://example.com/hook",
          event_types: ["task.completed"],
          secret_key: "secret",
          status: "active",
        },
      });

      const result = await client.registerWebhook({
        callbackUrl: "https://example.com/hook",
        eventTypes: ["task.completed"],
      });

      expect(result.id).toBe("wh-1");
      expect(result.secret_key).toBe("secret");

      // Verify flat shape (not nested under "webhook" key)
      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.callback_url).toBe("https://example.com/hook");
      expect(body.event_types).toEqual(["task.completed"]);
      expect(body).not.toHaveProperty("webhook");
    });

    it("lists webhooks", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: [{ id: "wh-1", callback_url: "https://example.com", status: "active", failure_count: 0 }],
      });

      const result = await client.listWebhooks();
      expect(result).toHaveLength(1);
    });

    it("deletes a webhook", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, { data: null });

      await client.deleteWebhook("wh-1");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/webhooks/wh-1",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // ledger operations
  // -------------------------------------------------------------------------

  describe("ledger operations", () => {
    it("lists transactions with filters", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: [{ id: "tx-1", type: "deposit", amount: "100" }],
      });

      const result = await client.getTransactions({ limit: 10, type: "deposit" });
      expect(result).toHaveLength(1);
      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("limit=10");
      expect(url).toContain("type=deposit");
    });

    it("deposits funds", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: { transaction_id: "tx-2", status: "pending", deposit_address: "0xabc" },
      });

      const result = await client.deposit({ amount: "50.00" });
      expect(result.transaction_id).toBe("tx-2");
    });

    it("withdraws funds", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: { transaction_id: "tx-3", status: "processing" },
      });

      const result = await client.withdraw({ amount: "25.00" });
      expect(result.transaction_id).toBe("tx-3");
    });
  });

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe("testConnection", () => {
    it("returns ok when balance fetch succeeds", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: { available: "100", escrow: "10", total: "110", currency: "USD" },
      });

      const result = await client.testConnection();
      expect(result.ok).toBe(true);
      expect(result.message).toContain("110");
      expect(result.message).toContain("USD");
    });

    it("returns error when API fails", { timeout: 15_000 }, async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(401, "Unauthorized");

      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("401");
    });
  });

  // -------------------------------------------------------------------------
  // uploadDocument
  // -------------------------------------------------------------------------

  describe("uploadDocument", () => {
    it("uploads a base64-encoded document to /api/v1/uploads", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          id: "doc-1",
          name: "instructions",
          file_url: "https://cdn.agrenting.com/doc-1",
          content_type: "text/plain",
          file_hash: "abc123",
          document_type: "instructions",
        },
      });

      const result = await client.uploadDocument({
        name: "instructions",
        content: "Do the thing",
        documentType: "instructions",
      });

      expect(result.id).toBe("doc-1");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/uploads",
        expect.objectContaining({ method: "POST" })
      );
      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      // Verify content is base64-encoded
      expect(body.content).toBe(Buffer.from("Do the thing").toString("base64"));
      expect(body.name).toBe("instructions");
      expect(body.content_type).toBe("text/plain");
      expect(body.document_type).toBe("instructions");
    });

    it("includes task_id when provided", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          id: "doc-2",
          name: "instructions",
          file_url: "https://cdn.agrenting.com/doc-2",
          content_type: "text/plain",
          file_hash: "def456",
          document_type: "instructions",
        },
      });

      const result = await client.uploadDocument({
        name: "instructions",
        content: "task instructions",
        documentType: "instructions",
        taskId: "task-123",
      });

      expect(result.id).toBe("doc-2");
      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.task_id).toBe("task-123");
    });
  });

  // -------------------------------------------------------------------------
  // Retry logic
  // -------------------------------------------------------------------------

  describe("retry logic", () => {
    it("retries on 500 errors and succeeds on retry", async () => {
      const client = new AgrentingClient(mockConfig);
      const fn = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          headers: new Headers(),
          text: async () => "Internal Server Error",
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({ data: { id: "task-ok" } }),
          json: async () => ({ data: { id: "task-ok" } }),
        });

      vi.stubGlobal("fetch", fn);

      const result = await client.getTask("retry-test");

      expect(result.id).toBe("task-ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries on 429 errors", async () => {
      const client = new AgrentingClient(mockConfig);
      const fn = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ "Retry-After": "0" }),
          text: async () => "Rate limited",
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({ data: { id: "r1" } }),
          json: async () => ({ data: { id: "r1" } }),
        });

      vi.stubGlobal("fetch", fn);

      const result = await client.getTask("r1");
      expect(result.id).toBe("r1");
    }, 30_000);

    it("throws after exhausting retries on 500", async () => {
      const client = new AgrentingClient(mockConfig);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          headers: new Headers(),
          text: async () => "Internal Server Error",
          json: async () => ({}),
        })
      );

      await expect(client.getTask("fail")).rejects.toThrow("500");
    }, 60_000);

    it("retries on network errors and eventually throws", async () => {
      const client = new AgrentingClient(mockConfig);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
      );

      await expect(client.getTask("net-fail")).rejects.toThrow("ECONNREFUSED");
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Error envelope handling
  // -------------------------------------------------------------------------

  describe("error envelope", () => {
    it("throws when response contains errors array", { timeout: 15_000 }, async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: null,
        errors: ["Something went wrong", "Invalid parameter"],
      });

      await expect(client.getTask("err")).rejects.toThrow("Something went wrong");
    });
  });

  // -------------------------------------------------------------------------
  // createPaymentIntent
  // -------------------------------------------------------------------------

  describe("createPaymentIntent", () => {
    it("creates a payment intent", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: { id: "pi-1", status: "pending", payment_url: "https://pay.example.com" },
      });

      const result = await client.createPaymentIntent({
        amount: "100.00",
        currency: "USD",
        paymentType: "crypto",
      });

      expect(result.id).toBe("pi-1");
      expect(result.payment_url).toBe("https://pay.example.com");
    });
  });

  // -------------------------------------------------------------------------
  // hireAgent
  // -------------------------------------------------------------------------

  describe("hireAgent", () => {
    it("hires an agent and returns adapter config", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          agent_did: "did:agrenting:hire-me",
          adapter_config: {
            agrentingUrl: "https://www.agrenting.com",
            agentDid: "did:agrenting:hire-me",
            pricingModel: "fixed",
          },
          status: "hired",
          hired_at: "2026-04-13T10:00:00Z",
        },
      });

      const result = await client.hireAgent("did:agrenting:hire-me");

      expect(result.agent_did).toBe("did:agrenting:hire-me");
      expect(result.status).toBe("hired");
      expect(result.adapter_config.pricingModel).toBe("fixed");
    });

    it("sends pricing model in request body", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          agent_did: "did:agrenting:x",
          adapter_config: { agrentingUrl: "https://www.agrenting.com", agentDid: "did:agrenting:x", pricingModel: "per-token" },
          status: "hired",
          hired_at: "2026-04-13T10:00:00Z",
        },
      });

      await client.hireAgent("did:agrenting:x", { pricingModel: "per-token" });

      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const body = JSON.parse(call[1].body);
      expect(body.pricing_model).toBe("per-token");
    });
  });

  // -------------------------------------------------------------------------
  // getAgentProfile
  // -------------------------------------------------------------------------

  describe("getAgentProfile", () => {
    it("fetches agent profile by DID", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          id: "agent-1",
          did: "did:agrenting:test-agent",
          name: "Test Agent",
          description: "A test agent",
          capabilities: ["code-review", "data-analysis"],
          pricing_model: "fixed",
          base_price: "10.00",
          reputation_score: 4.5,
          total_tasks_completed: 100,
          verified: true,
          availability_status: "available",
        },
      });

      const result = await client.getAgentProfile("did:agrenting:test-agent");

      expect(result.did).toBe("did:agrenting:test-agent");
      expect(result.name).toBe("Test Agent");
      expect(result.capabilities).toContain("code-review");
      expect(result.reputation_score).toBe(4.5);
      expect(result.availability_status).toBe("available");
    });
  });

  // -------------------------------------------------------------------------
  // sendMessageToTask
  // -------------------------------------------------------------------------

  describe("sendMessageToTask", () => {
    it("sends a message to a running task", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: { message_id: "msg-1", task_id: "task-42", sent_at: "2026-04-13T10:00:00Z" },
      });

      const result = await client.sendMessageToTask("task-42", { message: "Please add error handling" });

      expect(result.message_id).toBe("msg-1");
      expect(result.task_id).toBe("task-42");
    });

    it("sends message type in request body", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: { message_id: "msg-2", task_id: "task-42", sent_at: "2026-04-13T10:00:00Z" },
      });

      await client.sendMessageToTask("task-42", { message: "Good job!", messageType: "feedback" });

      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const body = JSON.parse(call[1].body);
      expect(body.message_type).toBe("feedback");
    });
  });

  // -------------------------------------------------------------------------
  // reassignTask
  // -------------------------------------------------------------------------

  describe("reassignTask", () => {
    it("reassigns a task to a new agent", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          task_id: "task-99",
          previous_agent_did: "did:agrenting:old",
          new_agent_did: "did:agrenting:new",
          reassigned_at: "2026-04-13T10:00:00Z",
        },
      });

      const result = await client.reassignTask("task-99", "did:agrenting:new");

      expect(result.task_id).toBe("task-99");
      expect(result.previous_agent_did).toBe("did:agrenting:old");
      expect(result.new_agent_did).toBe("did:agrenting:new");
    });

    it("reassigns without specifying agent (platform picks best)", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          task_id: "task-100",
          previous_agent_did: "did:agrenting:old",
          new_agent_did: "did:agrenting:auto-picked",
          reassigned_at: "2026-04-13T10:00:00Z",
        },
      });

      const result = await client.reassignTask("task-100");

      expect(result.new_agent_did).toBe("did:agrenting:auto-picked");
      // Verify empty body was sent
      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const body = JSON.parse(call[1].body);
      expect(body.new_agent_did).toBeUndefined();
    });
  });

  describe("listCapabilities", () => {
    it("GETs capabilities list", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: [
          { name: "code-review", description: "Review code quality", category: "development", agent_count: 10 },
          { name: "data-analysis", description: "Analyze datasets", category: "analytics", agent_count: 5 },
        ],
      });

      const result = await client.listCapabilities();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("code-review");
      expect(result[0].agent_count).toBe(10);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/capabilities",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  describe("sendMessageToHiring", () => {
    it("POSTs message to hiring messages endpoint", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          id: "msg-1",
          hiring_id: "h-123",
          sender_agent_id: "client-1",
          content: "Hello from client",
          created_at: "2025-01-01T00:00:00Z",
        },
      });

      const result = await client.sendMessageToHiring("h-123", "Hello from client");

      expect(result.id).toBe("msg-1");
      expect(result.content).toBe("Hello from client");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/hirings/h-123/messages",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("throws when message exceeds 5000 chars", async () => {
      const client = new AgrentingClient(mockConfig);
      const longMessage = "x".repeat(5001);

      await expect(client.sendMessageToHiring("h-123", longMessage)).rejects.toThrow(
        "Message content exceeds 5000 character limit"
      );
    });
  });

  describe("getHiringMessages", () => {
    it("GETs messages for a hiring", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: [
          { id: "msg-1", hiring_id: "h-123", sender_agent_id: "client-1", content: "Hello", created_at: "2025-01-01T00:00:00Z" },
        ],
      });

      const result = await client.getHiringMessages("h-123");

      expect(result).toHaveLength(1);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/hirings/h-123/messages",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  describe("retryHiring", () => {
    it("POSTs to retry endpoint", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          id: "h-123",
          agent_id: "agent-1",
          agent_did: "did:agrenting:test-agent",
          client_agent_id: "client-1",
          status: "active",
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:05:00Z",
        },
      });

      const result = await client.retryHiring("h-123", { reason: "previous timeout" });

      expect(result.id).toBe("h-123");
      expect(result.status).toBe("active");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/hirings/h-123/retry",
        expect.objectContaining({ method: "POST" })
      );
      const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.reason).toBe("previous timeout");
    });
  });

  describe("getHiring", () => {
    it("GETs hiring by ID", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: {
          id: "h-123",
          agent_id: "agent-1",
          agent_did: "did:agrenting:test-agent",
          client_agent_id: "client-1",
          status: "active",
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:00:00Z",
        },
      });

      const result = await client.getHiring("h-123");

      expect(result.id).toBe("h-123");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.agrenting.com/api/v1/hirings/h-123",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  describe("listHirings", () => {
    it("GETs hirings list with filters", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: [
          { id: "h-1", agent_id: "agent-1", status: "active", created_at: "2025-01-01T00:00:00Z" },
          { id: "h-2", agent_id: "agent-2", status: "completed", created_at: "2025-01-02T00:00:00Z" },
        ],
      });

      const result = await client.listHirings({ status: "active", limit: 10 });

      expect(result).toHaveLength(2);
      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("status=active");
      expect(url).toContain("limit=10");
    });
  });

  describe("listAgentsByCapability", () => {
    it("GETs agents filtered by capability", async () => {
      const client = new AgrentingClient(mockConfig);
      mockFetchResponse(200, {
        data: [
          { id: "agent-1", did: "did:agrenting:agent-1", name: "Agent 1", capabilities: ["code-review"] },
          { id: "agent-2", did: "did:agrenting:agent-2", name: "Agent 2", capabilities: ["code-review"] },
        ],
      });

      const result = await client.listAgentsByCapability("code-review");

      expect(result).toHaveLength(2);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/agents?capability=code-review"),
        expect.objectContaining({ method: "GET" })
      );
    });
  });
});
