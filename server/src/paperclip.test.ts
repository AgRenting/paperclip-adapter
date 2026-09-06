import type {
  AdapterEnvironmentTestContext,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCanonicalServerAdapter,
  executePaperclip,
  getPaperclipConfigSchema,
  paperclipSessionCodec,
  testPaperclipEnvironment,
} from "./paperclip.js";

const clientMocks = vi.hoisted(() => ({
  getAgentProfile: vi.fn(),
  hireAgent: vi.fn(),
  getHiring: vi.fn(),
  cancelHiring: vi.fn(),
  listHirings: vi.fn(),
}));

vi.mock("./client.js", () => ({
  AgrentingClient: vi.fn().mockImplementation(function () {
    return clientMocks;
  }),
}));

const profile = {
  id: "agent-1",
  did: "did:agrenting:reviewer",
  name: "Review Agent",
  capabilities: ["code-review"],
  pricing_model: "fixed",
  base_price: "7.50",
  reviews: { average_rating: 4.9, total_reviews: 12 },
  status: "active",
};

function executionContext(
  config: Record<string, unknown> = {},
  context: Record<string, unknown> = {}
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "paperclip-agent-1",
      companyId: "company-1",
      name: "Paperclip Worker",
      adapterType: "agrenting",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      agrentingUrl: "https://agrenting.com",
      apiKey: "ap_test",
      agentDid: profile.did,
      pollIntervalMs: 1,
      ...config,
    },
    context,
    onLog: vi.fn().mockResolvedValue(undefined),
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

function environmentContext(
  config: Record<string, unknown>
): AdapterEnvironmentTestContext {
  return {
    companyId: "company-1",
    adapterType: "agrenting",
    config,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMocks.getAgentProfile.mockResolvedValue(profile);
  clientMocks.listHirings.mockResolvedValue([]);
  clientMocks.cancelHiring.mockResolvedValue({
    id: "hiring-1",
    status: "cancelled",
  });
});

describe("canonical Paperclip adapter", () => {
  it("exposes the current ServerAdapterModule contract", () => {
    const adapter = createCanonicalServerAdapter();

    expect(adapter.type).toBe("agrenting");
    expect(adapter.execute).toBe(executePaperclip);
    expect(adapter.testEnvironment).toBe(testPaperclipEnvironment);
    expect(adapter.getConfigSchema?.()).toEqual(getPaperclipConfigSchema());
    expect(adapter.sessionCodec).toBe(paperclipSessionCodec);
  });

  it("creates a hiring with run-id idempotency and polls to completion", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: {
        id: "hiring-1",
        status: "paid",
        price: "7.50",
      },
      config: {
        agentDid: profile.did,
        pricingModel: "fixed",
        basePrice: "7.50",
        capabilities: ["code-review"],
        hiringId: "hiring-1",
      },
    });
    clientMocks.getHiring.mockResolvedValue({
      id: "hiring-1",
      status: "completed",
      price: "7.50",
      task_output: { result: "Review complete\nNo blockers found." },
    });
    const ctx = executionContext(
      { repoUrl: "https://github.com/example/repo" },
      {
        taskTitle: "Review authentication",
        taskBody: "Check the tests and authorization boundaries.",
        issueId: "issue-42",
      }
    );

    const result = await executePaperclip(ctx);

    expect(clientMocks.hireAgent).toHaveBeenCalledWith(profile.did, {
      taskDescription:
        "Review authentication\n\nCheck the tests and authorization boundaries.",
      capabilityRequested: "code-review",
      price: "7.50",
      deliveryMode: "output",
      clientIdempotencyKey: "run-123",
      taskInput: {
        paperclip_run_id: "run-123",
        paperclip_agent_id: "paperclip-agent-1",
        paperclip_company_id: "company-1",
        paperclip_issue_id: "issue-42",
      },
      repoUrl: "https://github.com/example/repo",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      costUsd: 7.5,
      summary: "Review complete",
      sessionParams: { hiringId: "hiring-1" },
    });
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "agrenting",
        context: expect.objectContaining({ hiringId: "hiring-1" }),
      })
    );
  });

  it("keeps delivered artifact metadata and authenticated download URLs in the completed result", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: {
        id: "hiring-artifacts",
        status: "completed",
        price: "7.50",
        task_output: {},
        artifacts: [
          {
            id: "artifact-1",
            name: "review.md",
            artifact_type: "file",
            content_type: "text/markdown",
            size_bytes: 42,
          },
        ],
      },
      config: {
        agentDid: profile.did,
        pricingModel: "fixed",
        basePrice: "7.50",
        capabilities: ["code-review"],
        hiringId: "hiring-artifacts",
      },
    });
    const ctx = executionContext();

    const result = await executePaperclip(ctx);

    expect(result).toMatchObject({
      exitCode: 0,
      summary: "Agrenting hiring hiring-artifacts completed with 1 artifact: review.md.",
      resultJson: {
        hiringId: "hiring-artifacts",
        status: "completed",
        taskOutput: {},
        artifacts: [
          {
            id: "artifact-1",
            name: "review.md",
            artifact_type: "file",
            content_type: "text/markdown",
            size_bytes: 42,
            download_url:
              "https://agrenting.com/api/v1/artifacts/artifact-1/download",
          },
        ],
      },
    });
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stdout",
      "Agrenting hiring hiring-artifacts completed with 1 artifact: review.md.\n"
    );
  });

  it("falls back to the canonical authenticated URL for malformed artifact metadata", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: {
        id: "hiring-malformed-artifact",
        status: "completed",
        price: "7.50",
        task_output: { result: "Delivered" },
        artifacts: [
          {
            id: "artifact-safe",
            name: "result.txt",
            download_url: "http://[malformed",
          },
        ],
      },
      config: {
        agentDid: profile.did,
        pricingModel: "fixed",
        basePrice: "7.50",
        capabilities: ["code-review"],
        hiringId: "hiring-malformed-artifact",
      },
    });

    const result = await executePaperclip(executionContext());

    expect(result).toMatchObject({
      exitCode: 0,
      resultJson: {
        artifacts: [
          {
            id: "artifact-safe",
            download_url:
              "https://agrenting.com/api/v1/artifacts/artifact-safe/download",
          },
        ],
      },
    });
  });

  it("reconciles a completion that wins the timeout cancellation race", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: { id: "hiring-race", status: "in_progress", price: "7.50" },
      config: {
        agentDid: profile.did,
        pricingModel: "fixed",
        basePrice: "7.50",
        capabilities: ["code-review"],
        hiringId: "hiring-race",
      },
    });
    clientMocks.cancelHiring.mockRejectedValue(
      new Error("Agrenting API 409: hiring is already terminal")
    );
    clientMocks.getHiring.mockResolvedValue({
      id: "hiring-race",
      status: "completed",
      price: "7.50",
      task_output: { result: "Finished at the deadline" },
      artifacts: [],
    });
    let clock = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      clock += 1_000;
      return clock;
    });

    const result = await executePaperclip(
      executionContext({ timeoutSec: 1, pollIntervalMs: 1 })
    );

    nowSpy.mockRestore();
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      summary: "Finished at the deadline",
      sessionParams: { hiringId: "hiring-race" },
    });
    expect(clientMocks.getHiring).toHaveBeenCalledWith("hiring-race");
  });

  it("logs each structured open question once and retains it in the final result", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: { id: "hiring-question", status: "in_progress", price: "7.50" },
      config: {
        agentDid: profile.did,
        pricingModel: "fixed",
        basePrice: "7.50",
        capabilities: ["code-review"],
        hiringId: "hiring-question",
      },
    });
    clientMocks.getHiring
      .mockResolvedValueOnce({
        id: "hiring-question",
        status: "in_progress",
        price: "7.50",
        open_questions: [
          {
            question_id: "question-1",
            content: "Should I include generated files?",
            asked_at: "2026-09-05T08:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "hiring-question",
        status: "completed",
        price: "7.50",
        task_output: { result: "Review complete" },
        artifacts: [],
        open_questions: [
          {
            question_id: "question-1",
            content: "Should I include generated files?",
            asked_at: "2026-09-05T08:00:00Z",
          },
        ],
      });
    const ctx = executionContext({ pollIntervalMs: 1 });

    const result = await executePaperclip(ctx);

    const questionLogs = vi.mocked(ctx.onLog).mock.calls.filter(
      ([stream, chunk]) =>
        stream === "stderr" &&
        chunk ===
          "[agrenting] Open question question-1: Should I include generated files?\n"
    );
    expect(questionLogs).toHaveLength(1);
    expect(result.resultJson).toMatchObject({
      openQuestions: [
        {
          question_id: "question-1",
          content: "Should I include generated files?",
          asked_at: "2026-09-05T08:00:00Z",
        },
      ],
    });
  });

  it("returns a structured failure for a terminal failed hiring", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: {
        id: "hiring-failed",
        status: "failed",
        failed_reason: "Remote tests failed",
        artifacts: [{ id: "artifact-partial", name: "partial.log" }],
        open_questions: [
          {
            question_id: "question-failed",
            content: "Can you clarify the failure?",
            asked_at: "2026-09-05T08:30:00Z",
          },
        ],
      },
      config: {
        agentDid: profile.did,
        pricingModel: "fixed",
        basePrice: "7.50",
        capabilities: ["code-review"],
        hiringId: "hiring-failed",
      },
    });

    const result = await executePaperclip(executionContext());

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      errorCode: "agrenting_hiring_failed",
      errorMessage: "Remote tests failed",
      sessionParams: { hiringId: "hiring-failed" },
      resultJson: {
        artifacts: [
          {
            id: "artifact-partial",
            name: "partial.log",
            download_url:
              "https://agrenting.com/api/v1/artifacts/artifact-partial/download",
          },
        ],
        openQuestions: [
          {
            question_id: "question-failed",
            content: "Can you clarify the failure?",
            asked_at: "2026-09-05T08:30:00Z",
          },
        ],
      },
    });
    expect(clientMocks.getHiring).not.toHaveBeenCalled();
  });

  it("retains an accepted hiring and resumes it after a polling outage on a later run", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: { id: "hiring-recover", status: "in_progress", price: "7.50" },
    });
    clientMocks.getHiring.mockRejectedValueOnce(new Error("Agrenting API 503: unavailable"));
    const failed = await executePaperclip(executionContext());
    expect(failed).toMatchObject({
      exitCode: 1,
      sessionDisplayId: "hiring-recover",
      sessionParams: { hiringId: "hiring-recover", recoveryRequired: true },
      resultJson: { hiringId: "hiring-recover", status: "in_progress" },
    });

    clientMocks.getHiring.mockResolvedValue({
      id: "hiring-recover", status: "completed", price: "7.50",
      task_output: { result: "Recovered original work" },
    });
    const next = executionContext();
    next.runId = "run-456";
    next.runtime.sessionParams = failed.sessionParams ?? null;
    const recovered = await executePaperclip(next);
    expect(recovered).toMatchObject({
      exitCode: 0,
      summary: "Recovered original work",
      sessionParams: { hiringId: "hiring-recover", recoveryRequired: false },
    });
    expect(clientMocks.hireAgent).toHaveBeenCalledTimes(1);
    expect(clientMocks.getAgentProfile).toHaveBeenCalledTimes(1);
  });

  it("returns accepted hiring recovery state even when the host logger fails", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: { id: "hiring-log-outage", status: "in_progress", price: "7.50" },
    });
    const ctx = executionContext();
    ctx.onLog = vi.fn().mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("Host log storage unavailable"));
    const failed = await executePaperclip(ctx);
    expect(failed).toMatchObject({
      exitCode: 1,
      sessionParams: { hiringId: "hiring-log-outage", recoveryRequired: true },
    });
    clientMocks.getHiring.mockResolvedValue({
      id: "hiring-log-outage", status: "completed", task_output: "Recovered after log outage",
    });
    const next = executionContext();
    next.runId = "next-run";
    next.runtime.sessionParams = failed.sessionParams ?? null;
    await expect(executePaperclip(next)).resolves.toMatchObject({
      exitCode: 0, summary: "Recovered after log outage",
    });
    expect(clientMocks.hireAgent).toHaveBeenCalledTimes(1);
  });

  it("does not create a replacement when recovery status cannot be read", async () => {
    const ctx = executionContext();
    ctx.runtime.sessionParams = { hiringId: "hiring-unknown", recoveryRequired: true };
    clientMocks.getHiring.mockRejectedValue(new Error("Agrenting API 404: not found"));
    const result = await executePaperclip(ctx);
    expect(result).toMatchObject({
      exitCode: 1,
      sessionParams: { hiringId: "hiring-unknown", recoveryRequired: true },
    });
    expect(clientMocks.hireAgent).not.toHaveBeenCalled();
  });

  it("resumes active legacy sessions without another paid creation", async () => {
    const ctx = executionContext();
    ctx.runtime.sessionParams = { hiringId: "hiring-legacy" };
    clientMocks.getHiring
      .mockResolvedValueOnce({ id: "hiring-legacy", status: "in_progress", price: "7.50" })
      .mockResolvedValue({ id: "hiring-legacy", status: "completed", price: "7.50", task_output: "Legacy result" });
    const result = await executePaperclip(ctx);
    expect(result).toMatchObject({ exitCode: 0, summary: "Legacy result" });
    expect(clientMocks.hireAgent).not.toHaveBeenCalled();
  });

  it("allows a new heartbeat after the previous hiring was conclusively reported", async () => {
    const ctx = executionContext();
    ctx.runtime.sessionParams = { hiringId: "hiring-old", recoveryRequired: false };
    clientMocks.hireAgent.mockResolvedValue({ hiring: { id: "hiring-new", status: "completed", price: "7.50", task_output: "New result" } });
    const result = await executePaperclip(ctx);
    expect(result).toMatchObject({ exitCode: 0, summary: "New result", sessionParams: { hiringId: "hiring-new", recoveryRequired: false } });
    expect(clientMocks.hireAgent).toHaveBeenCalledTimes(1);
  });

  it("blocks recovery when the configured marketplace origin changes", async () => {
    const ctx = executionContext({ agrentingUrl: "https://other.example" });
    ctx.runtime.sessionParams = { hiringId: "hiring-old", recoveryRequired: true, agrentingUrl: "https://agrenting.com" };
    const result = await executePaperclip(ctx);
    expect(result).toMatchObject({ exitCode: 1, sessionParams: { hiringId: "hiring-old", recoveryRequired: true } });
    expect(clientMocks.getHiring).not.toHaveBeenCalled();
    expect(clientMocks.hireAgent).not.toHaveBeenCalled();
  });

  it("keeps recovery required when neither cancellation nor reconciliation succeeds", async () => {
    clientMocks.hireAgent.mockResolvedValue({ hiring: { id: "hiring-uncertain", status: "in_progress", price: "7.50" } });
    clientMocks.cancelHiring.mockRejectedValue(new Error("Agrenting API 503: unavailable"));
    clientMocks.getHiring.mockRejectedValue(new Error("Agrenting API 503: unavailable"));
    let clock = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => { clock += 1000; return clock; });
    try {
      const result = await executePaperclip(executionContext({ timeoutSec: 1 }));
      expect(result).toMatchObject({ timedOut: true, sessionParams: { hiringId: "hiring-uncertain", recoveryRequired: true }, resultJson: { status: "in_progress" } });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("binds a newly accepted hiring to its current origin after a completed session", async () => {
    const ctx = executionContext({ agrentingUrl: "https://new-market.example" });
    ctx.runtime.sessionParams = { hiringId: "hiring-old", recoveryRequired: false, agrentingUrl: "https://old-market.example" };
    clientMocks.hireAgent.mockResolvedValue({ hiring: { id: "hiring-new", status: "in_progress", price: "7.50" } });
    clientMocks.getHiring.mockRejectedValue(new Error("Agrenting API 503: unavailable"));
    const result = await executePaperclip(ctx);
    expect(result).toMatchObject({ sessionParams: { hiringId: "hiring-new", recoveryRequired: true, agrentingUrl: "https://new-market.example" } });
  });

  it("blocks automatic replay when task context contains a credential", async () => {
    clientMocks.hireAgent.mockRejectedValue(new Error("Agrenting API 503: unavailable"));
    const original = executionContext({}, { taskDescription: "Use ap_test for this request" });
    const failed = await executePaperclip(original);
    expect(failed).toMatchObject({ sessionParams: { recoveryRequired: true, pendingCreate: { idempotencyKey: "run-123", manualOnly: true } } });
    expect(JSON.stringify(failed.sessionParams)).not.toContain("ap_test");
    const next = executionContext();
    next.runId = "new-run";
    next.runtime.sessionParams = failed.sessionParams ?? null;
    const result = await executePaperclip(next);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "agrenting_hiring_reconciliation_required" });
    expect(clientMocks.hireAgent).toHaveBeenCalledTimes(1);
  });

  it("never falls through to a new creation when a saved create replay conflicts", async () => {
    clientMocks.hireAgent.mockRejectedValueOnce(new Error("Agrenting API 503: unavailable"));
    const failed = await executePaperclip(executionContext());
    const next = executionContext();
    next.runId = "new-run";
    next.runtime.sessionParams = failed.sessionParams ?? null;
    clientMocks.hireAgent.mockRejectedValue(new Error("Agrenting API 409: idempotency conflict"));
    const result = await executePaperclip(next);
    expect(result).toMatchObject({ exitCode: 1, sessionParams: { recoveryRequired: true, pendingCreate: { idempotencyKey: "run-123" } } });
    expect(clientMocks.getAgentProfile).toHaveBeenCalledTimes(1);
    expect(clientMocks.hireAgent).toHaveBeenLastCalledWith(profile.did, expect.objectContaining({ clientIdempotencyKey: "run-123" }));
  });

  it("requires reconciliation if pending recovery state is incomplete", async () => {
    const ctx = executionContext();
    ctx.runtime.sessionParams = { recoveryRequired: true, pendingCreate: "invalid" };
    const result = await executePaperclip(ctx);
    expect(result).toMatchObject({ exitCode: 1, sessionParams: { recoveryRequired: true } });
    expect(clientMocks.hireAgent).not.toHaveBeenCalled();
  });

  it("does not replay an ambiguous create using a different API credential", async () => {
    clientMocks.hireAgent.mockRejectedValue(new Error("Agrenting API 503: unavailable"));
    const failed = await executePaperclip(executionContext());
    const next = executionContext({ apiKey: "different-api-key" });
    next.runtime.sessionParams = failed.sessionParams ?? null;
    const result = await executePaperclip(next);
    expect(result).toMatchObject({ exitCode: 1, sessionParams: { recoveryRequired: true } });
    expect(clientMocks.hireAgent).toHaveBeenCalledTimes(1);
  });

  it("reports a terminal legacy session once without another hiring or duplicate cost", async () => {
    const ctx = executionContext();
    ctx.runtime.sessionParams = { hiringId: "legacy-completed" };
    clientMocks.getHiring.mockResolvedValue({ id: "legacy-completed", status: "completed", price: "7.50", task_output: "Old result" });
    const result = await executePaperclip(ctx);
    expect(result).toMatchObject({ exitCode: 0, summary: "Old result", costUsd: null, sessionParams: { hiringId: "legacy-completed", recoveryRequired: false } });
    expect(clientMocks.hireAgent).not.toHaveBeenCalled();
  });

  it("logs the actual terminal state returned by cancellation", async () => {
    clientMocks.hireAgent.mockResolvedValue({ hiring: { id: "hiring-race-return", status: "in_progress", price: "7.50" } });
    clientMocks.cancelHiring.mockResolvedValue({ id: "hiring-race-return", status: "completed", price: "7.50", task_output: "Completed during cancellation" });
    let clock = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => { clock += 1000; return clock; });
    const ctx = executionContext({ timeoutSec: 1 });
    try {
      const result = await executePaperclip(ctx);
      expect(result.exitCode).toBe(0);
      expect(vi.mocked(ctx.onLog).mock.calls.flat().join(" ")).not.toContain("was cancelled");
      expect(vi.mocked(ctx.onLog).mock.calls.flat().join(" ")).toContain("completed");
    } finally { nowSpy.mockRestore(); }
  });

  it("best-effort cancels a hiring when its Paperclip run times out", async () => {
    clientMocks.hireAgent.mockResolvedValue({
      hiring: { id: "hiring-timeout", status: "in_progress" },
      config: {
        agentDid: profile.did,
        pricingModel: "fixed",
        basePrice: "7.50",
        capabilities: ["code-review"],
        hiringId: "hiring-timeout",
      },
    });
    clientMocks.cancelHiring.mockResolvedValue({ id: "hiring-timeout", status: "cancelled" });
    let clock = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      clock += 1_000;
      return clock;
    });

    const result = await executePaperclip(
      executionContext({ timeoutSec: 1, pollIntervalMs: 1 })
    );

    nowSpy.mockRestore();
    expect(clientMocks.cancelHiring).toHaveBeenCalledWith("hiring-timeout");
    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      errorCode: "agrenting_hiring_cancelled",
      resultJson: { status: "cancelled" },
      sessionParams: { hiringId: "hiring-timeout" },
    });
  });
});

describe("canonical environment and configuration", () => {
  it("returns structured connectivity and agent-profile checks", async () => {
    const result = await testPaperclipEnvironment(
      environmentContext({
        agrentingUrl: "https://agrenting.com",
        apiKey: "ap_test",
        agentDid: profile.did,
      })
    );

    expect(result.status).toBe("pass");
    expect(result.adapterType).toBe("agrenting");
    expect(result.checks.map((check) => check.code)).toEqual([
      "agrenting_connection_ok",
      "agrenting_agent_profile_ok",
    ]);
  });

  it("fails locally when required configuration is missing", async () => {
    const result = await testPaperclipEnvironment(
      environmentContext({ agrentingUrl: "not-a-url" })
    );

    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toEqual([
      "agrenting_url_invalid",
      "agrenting_api_key_missing",
      "agrenting_agent_did_missing",
    ]);
    expect(clientMocks.listHirings).not.toHaveBeenCalled();
  });

  it("publishes secret, hiring, polling, and output-first config fields", () => {
    const schema = getPaperclipConfigSchema();
    const fields = Object.fromEntries(
      schema.fields.map((field) => [field.key, field])
    );

    expect(fields.apiKey.meta).toEqual({ secret: true });
    expect(fields.capabilityRequested).toBeDefined();
    expect(fields.price).toBeDefined();
    expect(fields.pollIntervalMs).toBeDefined();
    expect(fields.repoUrl).toBeDefined();
    expect(fields.deliveryMode.default).toBe("output");
  });

  it("round-trips hiring session state", () => {
    const state = { hiringId: "hiring-1" };

    expect(paperclipSessionCodec.deserialize(state)).toEqual(state);
    expect(paperclipSessionCodec.serialize(state)).toEqual(state);
    expect(paperclipSessionCodec.getDisplayId?.(state)).toBe("hiring-1");
    expect(paperclipSessionCodec.decode(paperclipSessionCodec.encode(state))).toEqual(
      state
    );
  });
});
