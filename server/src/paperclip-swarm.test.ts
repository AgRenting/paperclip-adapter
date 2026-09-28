import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  centsToPrice,
  classifySwarmCreateError,
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

const configRoster = {
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
    const parsed = swarmConfigFrom({ roster: configRoster, maxTotalPrice: "50.00" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.maxTotalPriceCents).toBe(5000);
    expect(parsed.value.swarmCreateWakeReasons).toEqual(["issue_assigned", "issue_commented"]);
    expect(parsed.value.roster?.members[1].price).toBe("10.00");
    expect(swarmConfigFrom({ roster: JSON.stringify(configRoster), maxTotalPrice: "50.00" })).toEqual(parsed);
  });

  it("reads wake reasons from a comma list or an array", () => {
    const fromText = swarmConfigFrom({ roster: configRoster, maxTotalPrice: "50.00", swarmCreateWakeReasons: "a, b,,c" });
    const fromList = swarmConfigFrom({ roster: configRoster, maxTotalPrice: "50.00", swarmCreateWakeReasons: ["x"] });
    expect(fromText.ok && fromText.value.swarmCreateWakeReasons).toEqual(["a", "b", "c"]);
    expect(fromList.ok && fromList.value.swarmCreateWakeReasons).toEqual(["x"]);
  });

  it("accepts a team listing on its own", () => {
    const parsed = swarmConfigFrom({ teamListingId: "listing-1", maxTotalPrice: "50.00" });
    expect(parsed).toMatchObject({ ok: true, value: { roster: null, savedTeamId: null, teamListingId: "listing-1" } });
  });

  it("requires exactly one team source", () => {
    const cases: Array<Record<string, unknown>> = [
      { roster: configRoster, savedTeamId: "team-1" },
      {},
      { roster: configRoster, teamListingId: "listing-1" },
      { savedTeamId: "team-1", teamListingId: "listing-1" },
      { roster: configRoster, savedTeamId: "team-1", teamListingId: "listing-1" },
    ];
    for (const source of cases) {
      expect(swarmConfigFrom({ ...source, maxTotalPrice: "50.00" })).toEqual({ ok: false, error: exactlyOne });
    }
  });

  it("requires a positive maxTotalPrice", () => {
    const error = 'Swarm mode requires maxTotalPrice, a USD amount such as "60.00".';
    expect(swarmConfigFrom({ roster: configRoster })).toEqual({ ok: false, error });
    expect(swarmConfigFrom({ roster: configRoster, maxTotalPrice: "0" })).toEqual({ ok: false, error });
  });

  it("returns the first roster problem as an exact sentence", () => {
    const member = { agentDid: "did:agrenting:m", capability: "testing", price: "1.00" };
    const errorFor = (roster: unknown) => swarmConfigFrom({ roster, maxTotalPrice: "50.00" });
    expect(errorFor("{")).toEqual({ ok: false, error: "roster must be valid JSON." });
    expect(errorFor({ lead: configRoster.lead, members: Array(9).fill(member) }))
      .toEqual({ ok: false, error: "roster.members must list 1 to 8 members." });
    expect(errorFor({ lead: { agentDid: "did:agrenting:lead", capability: "planning" }, members: [member] }))
      .toEqual({ ok: false, error: 'roster.lead.price must be a USD amount such as "15.00".' });
    expect(errorFor({ lead: configRoster.lead, members: [member, { ...member, note: "n".repeat(501) }] }))
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
