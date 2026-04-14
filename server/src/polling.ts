/**
 * Fallback polling logic for Agrenting task status.
 *
 * Used when webhooks are delayed or fail to deliver.
 * Polls with exponential backoff: 10s → 30s → 60s → 120s (max 10 polls).
 */

import { AgrentingClient } from "./client.js";
import type {
  AgrentingAdapterConfig,
  AgrentingExecutionResult,
  AgrentingTask,
} from "./types.js";

/** Poll intervals in milliseconds (exponential backoff) — shared across polling modes */
export const POLL_INTERVALS_MS = [10_000, 30_000, 60_000, 120_000];
export const MAX_POLLS = 10;

/** Compute the backoff duration for a given poll attempt (0-indexed). */
export function getBackoffMs(attempt: number): number {
  const index = Math.min(attempt, POLL_INTERVALS_MS.length - 1);
  return POLL_INTERVALS_MS[index];
}

export interface PollOptions {
  config: AgrentingAdapterConfig;
  taskId: string;
  /** Deadline in ms (Date.now() + timeoutMs) */
  deadline: number;
  /** Optional callback fired on each poll cycle with the current task state */
  onStatusUpdate?: (task: AgrentingTask, pollAttempt: number) => void;
  /** Starting poll attempt (useful for resuming after a webhook delay) */
  startAttempt?: number;
  /** AbortSignal to cancel polling early (e.g., when a webhook resolves first) */
  signal?: AbortSignal;
}

export interface PollResult {
  /** Final execution result */
  result: AgrentingExecutionResult;
  /** Number of polls performed */
  pollCount: number;
  /** Whether the result came from polling (true) or was already resolved */
  viaPolling: boolean;
}

/**
 * Poll the Agrenting task API with exponential backoff until the task
 * reaches a terminal state or the deadline is reached.
 */
export async function pollTaskUntilDone(
  options: PollOptions
): Promise<PollResult> {
  const client = new AgrentingClient(options.config);
  let pollAttempt = options.startAttempt ?? 0;
  const startTime = Date.now();

  while (pollAttempt < MAX_POLLS) {
    // Check if polling was aborted (e.g., webhook resolved first)
    if (options.signal?.aborted) {
      return {
        result: {
          success: false,
          error: "Polling aborted",
          taskId: options.taskId,
          durationMs: Date.now() - startTime,
        },
        pollCount: pollAttempt,
        viaPolling: true,
      };
    }

    const now = Date.now();
    if (now >= options.deadline) {
      return {
        result: {
          success: false,
          error: `Task timed out after ${options.config.timeoutSec ?? 600}s`,
          taskId: options.taskId,
          durationMs: now - startTime,
        },
        pollCount: pollAttempt,
        viaPolling: true,
      };
    }

    // Wait for the next poll interval (respects abort signal).
    // Skip the wait on the first iteration so the first poll is immediate.
    if (pollAttempt > 0) {
      const waitMs = getBackoffMs(pollAttempt);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        if (options.signal) {
          options.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }
      });
    }

    const task = await client.getTask(options.taskId);
    pollAttempt++;

    options.onStatusUpdate?.(task, pollAttempt);

    if (task.status === "completed") {
      return {
        result: {
          success: true,
          output: task.output,
          taskId: options.taskId,
          durationMs: Date.now() - startTime,
        },
        pollCount: pollAttempt,
        viaPolling: true,
      };
    }

    if (task.status === "failed") {
      return {
        result: {
          success: false,
          error: task.error_reason ?? "Task failed with no reason provided",
          taskId: options.taskId,
          durationMs: Date.now() - startTime,
        },
        pollCount: pollAttempt,
        viaPolling: true,
      };
    }

    if (task.status === "cancelled") {
      return {
        result: {
          success: false,
          error: "Task was cancelled",
          taskId: options.taskId,
          durationMs: Date.now() - startTime,
        },
        pollCount: pollAttempt,
        viaPolling: true,
      };
    }
  }

  // Max polls reached without terminal state — do one final check
  const finalTask = await client.getTask(options.taskId);
  if (finalTask.status === "completed") {
    return {
      result: {
        success: true,
        output: finalTask.output,
        taskId: options.taskId,
        durationMs: Date.now() - startTime,
      },
      pollCount: pollAttempt + 1,
      viaPolling: true,
    };
  }

  return {
    result: {
      success: false,
      error: `Task did not complete after ${pollAttempt} polls (max ${MAX_POLLS})`,
      taskId: options.taskId,
      durationMs: Date.now() - startTime,
    },
    pollCount: pollAttempt,
    viaPolling: true,
  };
}

/**
 * Calculate when to activate fallback polling.
 * Returns the number of ms to wait before switching from webhook
 * wait mode to polling mode.
 */
export function getWebhookGracePeriodMs(config: AgrentingAdapterConfig): number {
  // Default: 60 seconds. If the timeout is very short, use a fraction of it.
  const timeoutMs = (config.timeoutSec ?? 600) * 1000;
  return Math.min(60_000, timeoutMs * 0.1);
}
