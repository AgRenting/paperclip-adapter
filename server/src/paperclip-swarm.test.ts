import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  centsToPrice,
  classifySwarmCreateError,
  executePaperclip,
  priceToCents,
  swarmConfigFrom,
  swarmReplayAllowed,
  swarmRequestFromRecovery,
  swarmWakeReasonFrom,
} from "./paperclip.js";

const clientMocks = vi.hoisted(() => ({
  createSwarm: vi.fn(),
  getSwarm: vi.fn(),
  listSavedTeams: vi.fn(),
  getTeamListing: vi.fn(),
  listHirings: vi.fn(),
  hireAgent: vi.fn(),
  getHiring: vi.fn(),
  cancelHiring: vi.fn(),
  getAgentProfile: vi.fn(),
}));

vi.mock("./client.js", () => ({
  AgrentingClient: vi.fn().mockImplementation(function () {
    return clientMocks;
  }),
}));

beforeEach(() => {
  for (const mock of Object.values(clientMocks)) mock.mockReset();
  clientMocks.listHirings.mockResolvedValue([]);
});

function apiError(status: number, code: string, details: unknown[] = []) {
  return Object.assign(new Error(`Agrenting API ${status}: ${code}`), {
    status,
    code,
    apiMessage: `${code} message`,
    details,
  });
}

const roster = {
  lead: { agentDid: "did:agrenting:lead", capability: "planning", price: "20.00" },
  members: [
    { agentDid: "did:agrenting:reviewer", capability: "code-review", price: "15.00", note: "Focus on auth." },
    { agentDid: "did:agrenting:tester", capability: "testing", price: "10" },
  ],
};

describe("team price helpers", () => {
  it("parses USD amounts into cents", () => {
    expect(priceToCents("45.00")).toBe(4500);
    expect(priceToCents("10")).toBe(1000);
    expect(priceToCents(15.5)).toBe(1550);
  });

  it("refuses amounts that are not plain USD", () => {
    for (const value of ["1.234", "-1", "abc", "", undefined]) {
      expect(priceToCents(value)).toBeNull();
    }
  });

  it("formats cents as a USD amount", () => {
    expect(centsToPrice(4500)).toBe("45.00");
    expect(centsToPrice(105)).toBe("1.05");
    expect(centsToPrice(0)).toBe("0.00");
  });
});

describe("team replay window", () => {
  const createdAt = "2026-09-26T10:00:00.000Z";

  it("allows a replay up to and including 30 minutes after the first attempt", () => {
    expect(swarmReplayAllowed(createdAt, new Date("2026-09-26T10:29:59.000Z"))).toBe(true);
    expect(swarmReplayAllowed(createdAt, new Date("2026-09-26T10:30:00.000Z"))).toBe(true);
  });

  it("refuses a replay after the window, before the attempt, or without a readable time", () => {
    expect(swarmReplayAllowed(createdAt, new Date("2026-09-26T10:30:00.001Z"))).toBe(false);
    expect(swarmReplayAllowed(createdAt, new Date("2026-09-26T09:59:59.000Z"))).toBe(false);
    for (const value of ["garbage", null, undefined]) {
      expect(swarmReplayAllowed(value, new Date("2026-09-26T10:10:00.000Z"))).toBe(false);
    }
  });
});

describe("team create failure kinds", () => {
  it("treats 5xx, 429, 408 and network errors as ambiguous", () => {
    for (const error of [apiError(503, "X"), apiError(429, "X"), apiError(408, "X"), new TypeError("fetch failed")]) {
      expect(classifySwarmCreateError(error).kind).toBe("ambiguous");
    }
  });

  it("treats IDEMPOTENCY_CONFLICT as a conflict", () => {
    expect(classifySwarmCreateError(apiError(409, "IDEMPOTENCY_CONFLICT")).kind).toBe("conflict");
  });

  it("keeps the code, message and details of a definitive refusal", () => {
    expect(
      classifySwarmCreateError(apiError(409, "AGENT_BUSY", [{ slot: "members[0]", code: "agent_busy" }]))
    ).toEqual({
      kind: "definitive",
      httpStatus: 409,
      code: "AGENT_BUSY",
      message: "AGENT_BUSY message",
      details: [{ slot: "members[0]", code: "agent_busy" }],
    });
    expect(classifySwarmCreateError(apiError(401, "UNAUTHORIZED")).kind).toBe("definitive");
  });
});

describe("team wake reason", () => {
  it("reads wakeReason first, then paperclipWake.reason", () => {
    expect(swarmWakeReasonFrom({ wakeReason: " issue_assigned " })).toBe("issue_assigned");
    expect(swarmWakeReasonFrom({ paperclipWake: { reason: "issue_commented" } })).toBe("issue_commented");
    expect(
      swarmWakeReasonFrom({ wakeReason: "heartbeat_timer", paperclipWake: { reason: "issue_assigned" } })
    ).toBe("heartbeat_timer");
    expect(swarmWakeReasonFrom({})).toBeNull();
  });
});

describe("team config", () => {
  const exactlyOne = "Swarm mode requires exactly one of roster, savedTeamId or teamListingId.";

  it("parses a roster, the budget and the default wake reasons", () => {
    const parsed = swarmConfigFrom({ roster: roster, maxTotalPrice: "50.00" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.maxTotalPriceCents).toBe(5000);
    expect(parsed.value.swarmCreateWakeReasons).toEqual(["issue_assigned", "issue_commented"]);
    expect(parsed.value.roster?.members[1].price).toBe("10.00");
    expect(swarmConfigFrom({ roster: JSON.stringify(roster), maxTotalPrice: "50.00" })).toEqual(parsed);
  });

  it("reads wake reasons from a comma list or an array", () => {
    const fromText = swarmConfigFrom({ roster: roster, maxTotalPrice: "50.00", swarmCreateWakeReasons: "a, b,,c" });
    const fromList = swarmConfigFrom({ roster: roster, maxTotalPrice: "50.00", swarmCreateWakeReasons: ["x"] });
    expect(fromText.ok && fromText.value.swarmCreateWakeReasons).toEqual(["a", "b", "c"]);
    expect(fromList.ok && fromList.value.swarmCreateWakeReasons).toEqual(["x"]);
  });

  it("accepts a team listing on its own", () => {
    const parsed = swarmConfigFrom({ teamListingId: "listing-1", maxTotalPrice: "50.00" });
    expect(parsed).toMatchObject({ ok: true, value: { roster: null, savedTeamId: null, teamListingId: "listing-1" } });
  });

  it("requires exactly one team source", () => {
    const cases: Array<Record<string, unknown>> = [
      { roster: roster, savedTeamId: "team-1" },
      {},
      { roster: roster, teamListingId: "listing-1" },
      { savedTeamId: "team-1", teamListingId: "listing-1" },
      { roster: roster, savedTeamId: "team-1", teamListingId: "listing-1" },
    ];
    for (const source of cases) {
      expect(swarmConfigFrom({ ...source, maxTotalPrice: "50.00" })).toEqual({ ok: false, error: exactlyOne });
    }
  });

  it("requires a positive maxTotalPrice", () => {
    const error = 'Swarm mode requires maxTotalPrice, a USD amount such as "60.00".';
    expect(swarmConfigFrom({ roster: roster })).toEqual({ ok: false, error });
    expect(swarmConfigFrom({ roster: roster, maxTotalPrice: "0" })).toEqual({ ok: false, error });
  });

  it("returns the first roster problem as an exact sentence", () => {
    const member = { agentDid: "did:agrenting:m", capability: "testing", price: "1.00" };
    const errorFor = (roster: unknown) => swarmConfigFrom({ roster, maxTotalPrice: "50.00" });
    expect(errorFor("{")).toEqual({ ok: false, error: "roster must be valid JSON." });
    expect(errorFor({ lead: roster.lead, members: Array(9).fill(member) }))
      .toEqual({ ok: false, error: "roster.members must list 1 to 8 members." });
    expect(errorFor({ lead: { agentDid: "did:agrenting:lead", capability: "planning" }, members: [member] }))
      .toEqual({ ok: false, error: 'roster.lead.price must be a USD amount such as "15.00".' });
    expect(errorFor({ lead: roster.lead, members: [member, { ...member, note: "n".repeat(501) }] }))
      .toEqual({ ok: false, error: "roster.members[1].note must be text of at most 500 characters." });
  });
});

describe("team snapshot replay", () => {
  const request = {
    task_description: "Harden auth",
    delivery_mode: "output",
    client_idempotency_key: "run-123",
    total_price: "45.00",
    saved_team_id: "team-1",
  };
  const snapshot = {
    kind: "swarm",
    idempotencyKey: "run-123",
    createdAt: "2026-09-26T10:00:00.000Z",
    request,
  };

  it("returns the saved request", () => {
    expect(swarmRequestFromRecovery(snapshot)).toEqual(request);
  });

  it("refuses a snapshot that is not an exact, replayable team request", () => {
    expect(swarmRequestFromRecovery({ ...snapshot, request: { ...request, repo_url: "https://example.com/r" } })).toBeNull();
    expect(swarmRequestFromRecovery({ ...snapshot, manualOnly: true })).toBeNull();
    expect(swarmRequestFromRecovery({ ...snapshot, idempotencyKey: "other" })).toBeNull();
    expect(
      swarmRequestFromRecovery({
        ...snapshot,
        request: {
          ...request,
          lead: { agent_did: "did:agrenting:lead", capability_requested: "planning", price: "20.00" },
          members: [],
        },
      })
    ).toBeNull();
    const withoutKind: Record<string, unknown> = { ...snapshot };
    delete withoutKind.kind;
    expect(swarmRequestFromRecovery(withoutKind)).toBeNull();
  });

  it("replays a listed team only on its own", () => {
    const listed = {
      task_description: "Harden auth",
      delivery_mode: "output",
      client_idempotency_key: "run-123",
      total_price: "45.00",
      team_listing_id: "listing-1",
    };
    expect(swarmRequestFromRecovery({ ...snapshot, request: listed })).toEqual(listed);
    expect(swarmRequestFromRecovery({ ...snapshot, request: { ...listed, saved_team_id: "team-1" } })).toBeNull();
    expect(
      swarmRequestFromRecovery({
        ...snapshot,
        request: {
          ...listed,
          lead: { agent_did: "did:agrenting:lead", capability_requested: "planning", price: "20.00" },
          members: [{ agent_did: "did:agrenting:m", capability_requested: "testing", price: "25.00" }],
        },
      })
    ).toBeNull();
  });
});

const NOW = new Date("2026-09-26T10:00:00.000Z");
const taskInput = {
  paperclip_run_id: "run-123",
  paperclip_agent_id: "paperclip-agent-1",
  paperclip_company_id: "company-1",
  paperclip_wake_reason: "issue_assigned",
};
const expectedRosterBody = {
  task_description: "Harden auth\n\nReview and test the auth module.",
  task_input: taskInput,
  delivery_mode: "output",
  client_idempotency_key: "run-123",
  total_price: "45.00",
  lead: { agent_did: "did:agrenting:lead", capability_requested: "planning", price: "20.00" },
  members: [
    { agent_did: "did:agrenting:reviewer", capability_requested: "code-review", price: "15.00", note: "Focus on auth." },
    { agent_did: "did:agrenting:tester", capability_requested: "testing", price: "10.00" },
  ],
};
const planning = {
  swarm_id: "swarm-1", status: "planning", final: false, phase: "plan",
  total_price: "45.00", held: "45.00", charged: "0.00", refunded: "0.00", members: [], open_questions: [], deliverable: null,
};
const completed = {
  swarm_id: "swarm-1", status: "completed", final: true, phase: "done", partial: false, failure_code: null,
  total_price: "45.00", held: "0.00", charged: "45.00", refunded: "0.00",
  lead: { hiring_id: "h-lead", agent: { did: "did:agrenting:lead", name: "Lead" }, status: "completed" },
  members: [
    { alias: "m1", hiring_id: "h-m1", agent: { did: "did:agrenting:reviewer", name: "Reviewer" }, capability: "code-review", status: "delivered", title: "Review auth" },
    { alias: "m2", hiring_id: "h-m2", agent: { did: "did:agrenting:tester", name: "Tester" }, capability: "testing", status: "delivered", title: "Test auth" },
  ],
  open_questions: [],
  deliverable: { task_output: { result: "Auth hardened\nDetails follow." }, artifact_ids: ["artifact-1"] },
};
const savedTeam = {
  id: "team-1", name: "Auth crew", total_price: "45.00",
  lead: { agent_did: "did:agrenting:lead", name: "Lead", capability: "planning", price: "20.00", available: true, note: null },
  members: [{ agent_did: "did:agrenting:reviewer", name: "Reviewer", capability: "code-review", price: "25.00", available: true, note: null }],
};
const teamListing = {
  id: "listing-1", slug: "auth-crew", name: "Auth crew", total_price: "45.00", agent_count: 3, available: true,
};

function swarmContext(
  config: Record<string, unknown> = {},
  context: Record<string, unknown> = { wakeReason: "issue_assigned", taskTitle: "Harden auth", taskBody: "Review and test the auth module." }
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: { id: "paperclip-agent-1", companyId: "company-1", name: "Paperclip Lead", adapterType: "agrenting", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { agrentingUrl: "https://agrenting.com", apiKey: "ap_test", mode: "swarm", roster, maxTotalPrice: "50.00", pollIntervalMs: 1, ...config },
    context,
    onLog: vi.fn().mockResolvedValue(undefined),
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

describe("team creation and budget", () => {
  it("creates one roster team keyed by the run id and reports charged as cost", async () => {
    clientMocks.createSwarm.mockResolvedValue(planning);
    clientMocks.getSwarm.mockResolvedValue(completed);
    const ctx = swarmContext();

    const result = await executePaperclip(ctx, NOW);

    expect(clientMocks.createSwarm).toHaveBeenCalledTimes(1);
    expect(clientMocks.createSwarm).toHaveBeenCalledWith(expectedRosterBody);
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      costUsd: 45,
      billingType: "fixed",
      summary: "Auth hardened",
      sessionParams: { mode: "swarm", swarmId: "swarm-1", recoveryRequired: false },
      sessionDisplayId: "swarm-1",
    });
    expect(ctx.onMeta).toHaveBeenCalledWith(expect.objectContaining({ command: "POST /api/v1/swarms" }));
    expect(clientMocks.getAgentProfile).not.toHaveBeenCalled();
    expect(clientMocks.hireAgent).not.toHaveBeenCalled();
  });

  it("refuses a roster above maxTotalPrice without sending it", async () => {
    const result = await executePaperclip(swarmContext({ maxTotalPrice: "40.00" }), NOW);

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "agrenting_swarm_rejected",
      errorMessage: "Team total 45.00 exceeds maxTotalPrice 40.00; no team was created.",
      sessionParams: { mode: "swarm", recoveryRequired: false },
      resultJson: {
        rejected: true,
        details: [{ slot: "total_price", code: "max_total_price_exceeded", total_price: "45.00", max_total_price: "40.00" }],
      },
    });
    expect(clientMocks.createSwarm).not.toHaveBeenCalled();
  });

  it("allows a total equal to maxTotalPrice", async () => {
    clientMocks.createSwarm.mockResolvedValue(completed);

    const result = await executePaperclip(swarmContext({ maxTotalPrice: "45.00" }), NOW);

    expect(result.exitCode).toBe(0);
    expect(clientMocks.createSwarm).toHaveBeenCalledTimes(1);
  });
});

describe("saved and listed teams", () => {
  const savedConfig = { roster: undefined, savedTeamId: "team-1" };
  const listedConfig = { roster: undefined, teamListingId: "listing-1" };

  it("hires a saved team at its current total", async () => {
    clientMocks.listSavedTeams.mockResolvedValue([savedTeam]);
    clientMocks.createSwarm.mockResolvedValue(completed);

    await executePaperclip(swarmContext(savedConfig), NOW);

    expect(clientMocks.createSwarm).toHaveBeenCalledWith({
      task_description: "Harden auth\n\nReview and test the auth module.",
      task_input: taskInput,
      delivery_mode: "output",
      client_idempotency_key: "run-123",
      total_price: "45.00",
      saved_team_id: "team-1",
    });
  });

  it("refuses a saved team above maxTotalPrice", async () => {
    clientMocks.listSavedTeams.mockResolvedValue([{ ...savedTeam, total_price: "55.00" }]);

    const result = await executePaperclip(swarmContext(savedConfig), NOW);

    expect(result).toMatchObject({
      errorCode: "agrenting_swarm_rejected",
      errorMessage: "Team total 55.00 exceeds maxTotalPrice 50.00; no team was created.",
    });
    expect(clientMocks.createSwarm).not.toHaveBeenCalled();
  });

  it("refuses a saved team that is not found", async () => {
    clientMocks.listSavedTeams.mockResolvedValue([]);

    const result = await executePaperclip(swarmContext(savedConfig), NOW);

    expect(result).toMatchObject({
      errorCode: "agrenting_swarm_rejected",
      errorMessage: "Saved team team-1 was not found for this API key; no team was created.",
      resultJson: { details: [{ slot: "saved_team_id", code: "not_found" }] },
    });
    expect(clientMocks.createSwarm).not.toHaveBeenCalled();
  });

  it("hires a listed team at its current total", async () => {
    clientMocks.getTeamListing.mockResolvedValue(teamListing);
    clientMocks.createSwarm.mockResolvedValue(completed);

    const result = await executePaperclip(swarmContext(listedConfig), NOW);

    expect(result.exitCode).toBe(0);
    expect(clientMocks.getTeamListing).toHaveBeenCalledWith("listing-1");
    expect(clientMocks.createSwarm).toHaveBeenCalledWith({
      task_description: "Harden auth\n\nReview and test the auth module.",
      task_input: taskInput,
      delivery_mode: "output",
      client_idempotency_key: "run-123",
      total_price: "45.00",
      team_listing_id: "listing-1",
    });
    expect(clientMocks.listSavedTeams).not.toHaveBeenCalled();
  });

  it("refuses a listed team above maxTotalPrice", async () => {
    clientMocks.getTeamListing.mockResolvedValue({ ...teamListing, total_price: "55.00" });

    const result = await executePaperclip(swarmContext(listedConfig), NOW);

    expect(result).toMatchObject({
      errorCode: "agrenting_swarm_rejected",
      errorMessage: "Team total 55.00 exceeds maxTotalPrice 50.00; no team was created.",
    });
    expect(clientMocks.createSwarm).not.toHaveBeenCalled();
  });

  it("refuses a listed team that is not found", async () => {
    clientMocks.getTeamListing.mockRejectedValue(apiError(404, "NOT_FOUND"));

    const result = await executePaperclip(swarmContext(listedConfig), NOW);

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "agrenting_swarm_rejected",
      errorMessage: "Team listing listing-1 was not found for this API key.",
      sessionParams: { mode: "swarm", recoveryRequired: false },
      resultJson: { rejected: true, details: [{ slot: "team_listing_id", code: "not_found" }] },
    });
    expect(clientMocks.createSwarm).not.toHaveBeenCalled();
  });
});

describe("team wake gating", () => {
  it("creates nothing on a wake reason outside swarmCreateWakeReasons", async () => {
    const result = await executePaperclip(swarmContext({}, { wakeReason: "heartbeat_timer", taskTitle: "Harden auth" }), NOW);

    expect(result).toMatchObject({
      exitCode: 0,
      summary: "No Agrenting team was created: wake reason heartbeat_timer is not in swarmCreateWakeReasons.",
      resultJson: { swarmCreated: false, wakeReason: "heartbeat_timer" },
    });
    expect(clientMocks.createSwarm).not.toHaveBeenCalled();
    expect(clientMocks.listSavedTeams).not.toHaveBeenCalled();
  });

  it("names a missing wake reason", async () => {
    const result = await executePaperclip(swarmContext({}, { taskTitle: "Harden auth" }), NOW);

    expect(result.summary).toContain("wake reason (none)");
    expect(clientMocks.createSwarm).not.toHaveBeenCalled();
  });

  it("reads the wake reason from paperclipWake", async () => {
    clientMocks.createSwarm.mockResolvedValue(completed);

    await executePaperclip(swarmContext({}, { paperclipWake: { reason: "issue_commented" }, taskTitle: "Harden auth" }), NOW);

    expect(clientMocks.createSwarm).toHaveBeenCalledTimes(1);
  });

  it("uses the configured wake reasons", async () => {
    clientMocks.createSwarm.mockResolvedValue(completed);
    const config = { swarmCreateWakeReasons: "manual_run" };

    await executePaperclip(swarmContext(config, { wakeReason: "issue_assigned", taskTitle: "Harden auth" }), NOW);
    expect(clientMocks.createSwarm).not.toHaveBeenCalled();

    await executePaperclip(swarmContext(config, { wakeReason: "manual_run", taskTitle: "Harden auth" }), NOW);
    expect(clientMocks.createSwarm).toHaveBeenCalledTimes(1);
  });
});

describe("task description truncation", () => {
  it("keeps a team task description within 5,000 characters", async () => {
    clientMocks.createSwarm.mockResolvedValue(completed);

    await executePaperclip(swarmContext({}, { wakeReason: "issue_assigned", taskBody: "x".repeat(6000) }), NOW);

    const description = clientMocks.createSwarm.mock.calls[0][0].task_description as string;
    expect(description).toHaveLength(5000);
    expect(description.endsWith("[truncated by Paperclip adapter]")).toBe(true);
  });

  it("keeps a single-hire task description within 5,000 characters", async () => {
    clientMocks.getAgentProfile.mockResolvedValue({
      id: "agent-1", did: "did:agrenting:reviewer", name: "Reviewer", capabilities: ["code-review"], base_price: "7.50",
    });
    clientMocks.hireAgent.mockResolvedValue({ hiring: { id: "hiring-1", status: "completed", price: "7.50", task_output: "ok" } });

    await executePaperclip(
      swarmContext({ mode: "hiring", agentDid: "did:agrenting:reviewer" }, { taskBody: "x".repeat(6000) }),
      NOW
    );

    expect((clientMocks.hireAgent.mock.calls[0][1].taskDescription as string)).toHaveLength(5000);
  });
});
