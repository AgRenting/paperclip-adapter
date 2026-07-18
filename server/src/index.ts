export { createServerAdapter } from "./adapter.js";
export { AgrentingClient } from "./client.js";
export {
  createWebhookHandler,
  registerTaskMapping,
  unregisterTaskMapping,
  getActiveTaskMappings,
} from "./webhook-handler.js";
export type {
  AgrentingWebhookPayload,
  PaperclipApiClient,
  WebhookHandlerOptions,
} from "./webhook-handler.js";
export {
  formatAgentResponse,
  forwardCommentToAgrenting,
  processIncomingMessage,
} from "./comment-sync.js";
export { pollTaskUntilDone, getWebhookGracePeriodMs, POLL_INTERVALS_MS, MAX_POLLS, getBackoffMs } from "./polling.js";
export type { PollOptions, PollResult } from "./polling.js";
export {
  checkBalance,
  canSubmitTask,
  formatLowBalanceComment,
  formatInsufficientBalanceComment,
} from "./balance-monitor.js";
export type { BalanceInfo, BalanceCheckOptions } from "./balance-monitor.js";
export { verifyWebhookSignature } from "./crypto.js";
export {
  registerWebhook,
  deregisterWebhook,
  hireAgent,
  getAgentProfile,
  sendMessageToTask,
  getTaskMessages,
  reassignTask,
  listCapabilities,
  sendMessageToHiring,
  getHiringMessages,
  retryHiring,
  cancelHiring,
  getHiring,
  listHirings,
  autoSelectAgent,
  executeWithRetry,
  // Legacy pre-0.4 task-oriented compatibility exports. The package-root
  // createServerAdapter() exposes Paperclip's current ServerAdapterModule.
  execute,
  testEnvironment,
  getConfigSchema,
  cancelTask,
  getTaskProgress,
  invoke,
  status,
  cancel,
  detectModel,
  listSkills,
  syncSkills,
  sessionCodec,
} from "./adapter.js";
export {
  type,
  label,
  agentConfigurationDoc,
  executePaperclip,
  testPaperclipEnvironment,
  getPaperclipConfigSchema,
  paperclipSessionCodec,
} from "./paperclip.js";
export { agrentingAppGalleryEntry } from "./apps-v2.js";
export type { PaperclipSkill } from "./adapter.js";
export type {
  AgrentingAdapterConfig,
  AgrentingExecutionResult,
  AgrentingTaskStatus,
  AgrentingTask,
  AgentInfo,
  AgentProfile,
  HireAgentResult,
  HireAgentOptions,
  HiringStatus,
  HiringListResult,
  SendMessageOptions,
  SendMessageResult,
  ReassignTaskResult,
  PaymentInfo,
  TransactionInfo,
  DiscoverAgentsOptions,
  CreateTaskPaymentOptions,
  Hiring,
  TaskMessage,
  HiringMessage,
  Capability,
  AutoSelectOptions,
  RetryHiringOptions,
} from "./types.js";
