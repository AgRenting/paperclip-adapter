/**
 * Balance monitoring for the Agrenting adapter.
 *
 * Monitors the platform balance via `GET /api/v1/ledger/balance`
 * and provides low-balance warnings and pre-submission checks.
 */

import { AgrentingClient } from "./client.js";
import type { AgrentingAdapterConfig } from "./types.js";

export interface BalanceInfo {
  available: number;
  escrow: number;
  total: number;
  currency: string;
  isLow: boolean;
  isInsufficient: boolean;
}

export interface BalanceCheckOptions {
  config: AgrentingAdapterConfig;
  /** Low balance threshold in USD (default: $10) */
  lowBalanceThresholdUsd?: number;
  /** Minimum balance required to submit a task in USD (default: $1) */
  minSubmissionBalanceUsd?: number;
}

/**
 * Fetch the current platform balance and evaluate thresholds.
 * The server returns { available, escrow, total } — we use `available`
 * for threshold checks since escrowed funds are already committed.
 */
export async function checkBalance(
  options: BalanceCheckOptions
): Promise<BalanceInfo> {
  const client = new AgrentingClient(options.config);
  const lowThreshold = options.lowBalanceThresholdUsd ?? 10;
  const minSubmission = options.minSubmissionBalanceUsd ?? 1;

  try {
    const raw = await client.getBalance();
    const available = parseFloat(raw.available);
    const escrow = parseFloat(raw.escrow);
    const total = parseFloat(raw.total);

    const anyNaN = Number.isNaN(available) || Number.isNaN(escrow) || Number.isNaN(total);
    if (anyNaN) {
      return {
        available: 0,
        escrow: 0,
        total: 0,
        currency: raw.currency ?? "USD",
        isLow: true,
        isInsufficient: true,
      };
    }

    return {
      available,
      escrow,
      total,
      currency: raw.currency ?? "USD",
      isLow: available < lowThreshold,
      isInsufficient: available < minSubmission,
    };
  } catch {
    // If we can't fetch balance, assume insufficient to avoid failed submissions
    return {
      available: 0,
      escrow: 0,
      total: 0,
      currency: "USD",
      isLow: true,
      isInsufficient: true,
    };
  }
}

/**
 * Pre-submission balance check.
 * Returns { ok: true } if sufficient, or { ok: false, reason } if not.
 */
export async function canSubmitTask(
  options: BalanceCheckOptions
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const balanceInfo = await checkBalance(options);

  if (balanceInfo.isInsufficient) {
    return {
      ok: false,
      reason: `Insufficient balance: ${formatUsd(balanceInfo.available)}. Minimum required: ${formatUsd(options.minSubmissionBalanceUsd ?? 1)}.`,
    };
  }

  return { ok: true };
}

/**
 * Format a USD amount as a human-readable dollar string.
 */
function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Generate a warning comment for low balance.
 * Returns the markdown comment to post on the Paperclip issue.
 */
export function formatLowBalanceComment(balanceInfo: BalanceInfo): string {
  return `**Agrenting balance warning** — Available: ${formatUsd(balanceInfo.available)} ${balanceInfo.currency} (Escrowed: ${formatUsd(balanceInfo.escrow)}). Funds are running low. Add credits to avoid task submission failures.`;
}

/**
 * Generate a blocking comment for insufficient balance.
 */
export function formatInsufficientBalanceComment(balanceInfo: BalanceInfo): string {
  return `**Agrenting task blocked** — Insufficient balance: ${formatUsd(balanceInfo.available)} ${balanceInfo.currency}. Please add credits to your Agrenting account before retrying.`;
}
