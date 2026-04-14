/**
 * Comment formatting utilities for bidirectional sync between
 * Paperclip issues and Agrenting task message threads.
 */

import type { AgrentingAdapterConfig, TaskMessage, SendMessageResult } from "./types.js";
import { AgrentingClient } from "./client.js";

/**
 * Process an Agrenting agent response and return the comment body
 * that should be posted on the Paperclip issue.
 *
 * This is called by the webhook handler when it receives task output
 * or progress messages that should appear as comments.
 */
export function formatAgentResponse(
  agentName: string,
  message: string
): string {
  return `**${agentName} says:**\n\n${message}`;
}

/**
 * Forward a comment from Paperclip to the Agrenting task.
 * Used for bidirectional comment sync when the user adds a comment
 * to a Paperclip issue that has an active Agrenting task.
 *
 * @param config - Agrenting adapter configuration
 * @param taskId - The Agrenting task ID
 * @param comment - The comment content to forward
 * @param authorName - Optional author name for attribution
 * @returns The created TaskMessage or null if forwarding failed
 */
export async function forwardCommentToAgrenting(
  config: AgrentingAdapterConfig,
  taskId: string,
  comment: string,
  authorName?: string
): Promise<SendMessageResult | null> {
  const client = new AgrentingClient(config);

  // Format the comment for Agrenting
  const formattedComment = authorName
    ? `[${authorName}]: ${comment}`
    : comment;

  try {
    return await client.sendMessageToTask(taskId, { message: formattedComment });
  } catch (err) {
    // Log but don't throw — comment sync is non-critical
    console.error(
      `[adapter-agrenting] Failed to forward comment to task ${taskId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Process incoming Agrenting messages and format them for Paperclip.
 * Called by the webhook handler when it receives task messages.
 *
 * @param message - The incoming TaskMessage from Agrenting
 * @returns Formatted comment body for Paperclip
 */
export function processIncomingMessage(
  message: TaskMessage
): string {
  const senderName = message.sender_name ?? "Agent";
  return formatAgentResponse(senderName, message.content);
}
