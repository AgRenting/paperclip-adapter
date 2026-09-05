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
      exitCode: null,
      timedOut: true,
      errorCode: "agrenting_hiring_timeout",
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
