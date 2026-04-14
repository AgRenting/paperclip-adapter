import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkBalance,
  canSubmitTask,
  formatLowBalanceComment,
  formatInsufficientBalanceComment,
} from "./balance-monitor.js";

const mockConfig = {
  agrentingUrl: "https://example.agrenting.com",
  apiKey: "test-key",
  agentDid: "did:agrenting:test",
};

function mockBalanceResponse(available: string, escrow = "0", total = available, currency = "USD") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ available, escrow, total, currency }),
    })
  );
}

function mockFetchError() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Network error"))
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("checkBalance", () => {
  it("returns balance info when API returns valid numbers", async () => {
    mockBalanceResponse("50.00", "10.00", "60.00");
    const result = await checkBalance({ config: mockConfig });
    expect(result).toEqual({
      available: 50,
      escrow: 10,
      total: 60,
      currency: "USD",
      isLow: false,
      isInsufficient: false,
    });
  });

  it("marks balance as low when below threshold", async () => {
    mockBalanceResponse("5.00", "0", "5.00"); // $5, below $10 threshold
    const result = await checkBalance({ config: mockConfig });
    expect(result.isLow).toBe(true);
    expect(result.isInsufficient).toBe(false);
  });

  it("marks balance as insufficient when below minimum submission", async () => {
    mockBalanceResponse("0.50", "0", "0.50"); // $0.50, below $1 threshold
    const result = await checkBalance({ config: mockConfig });
    expect(result.isLow).toBe(true);
    expect(result.isInsufficient).toBe(true);
  });

  it("handles NaN balance gracefully", async () => {
    mockBalanceResponse("not-a-number", "0", "not-a-number");
    const result = await checkBalance({ config: mockConfig });
    expect(result).toEqual({
      available: 0,
      escrow: 0,
      total: 0,
      currency: "USD",
      isLow: true,
      isInsufficient: true,
    });
  });

  it("handles fetch errors by returning insufficient balance", { timeout: 15_000 }, async () => {
    mockFetchError();
    const result = await checkBalance({ config: mockConfig });
    expect(result).toEqual({
      available: 0,
      escrow: 0,
      total: 0,
      currency: "USD",
      isLow: true,
      isInsufficient: true,
    });
  });

  it("respects custom thresholds", async () => {
    mockBalanceResponse("20.00", "0", "20.00"); // $20
    const result = await checkBalance({
      config: mockConfig,
      lowBalanceThresholdUsd: 50,
      minSubmissionBalanceUsd: 5,
    });
    expect(result.isLow).toBe(true);
    expect(result.isInsufficient).toBe(false);
  });
});

describe("canSubmitTask", () => {
  it("returns ok when balance is sufficient", async () => {
    mockBalanceResponse("50.00");
    const result = await canSubmitTask({ config: mockConfig });
    expect(result).toEqual({ ok: true });
  });

  it("returns reason when balance is insufficient", async () => {
    mockBalanceResponse("0.50");
    const result = await canSubmitTask({ config: mockConfig });
    expect(result).toEqual({
      ok: false,
      reason: "Insufficient balance: $0.50. Minimum required: $1.00.",
    });
  });
});

describe("formatLowBalanceComment", () => {
  it("returns a markdown warning comment", () => {
    const comment = formatLowBalanceComment({
      available: 8,
      escrow: 2,
      total: 10,
      currency: "USD",
      isLow: true,
      isInsufficient: false,
    });
    expect(comment).toContain("**Agrenting balance warning**");
    expect(comment).toContain("$8.00");
  });
});

describe("formatInsufficientBalanceComment", () => {
  it("returns a markdown blocking comment", () => {
    const comment = formatInsufficientBalanceComment({
      available: 0,
      escrow: 0,
      total: 0,
      currency: "USD",
      isLow: true,
      isInsufficient: true,
    });
    expect(comment).toContain("**Agrenting task blocked**");
    expect(comment).toContain("$0.00");
  });
});
