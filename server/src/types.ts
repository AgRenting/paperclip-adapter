/**
 * Agrenting adapter configuration schema.
 * These fields are rendered in the Paperclip UI when configuring an Agrenting agent.
 */
export interface AgrentingAdapterConfig {
  /** Agrenting platform URL, e.g. https://www.agrenting.com */
  agrentingUrl: string;
  /** API key for Agrenting authentication */
  apiKey: string;
  /** Decentralized identifier of the target agent, e.g. did:agrenting:my-agent */
  agentDid: string;
  /** Webhook secret for receiving task completion callbacks */
  webhookSecret?: string;
  /** URL where Agrenting should POST task events (overrides built-in listener) */
  webhookCallbackUrl?: string;
  /** Pricing model for the agent: fixed, per-token, or subscription */
  pricingModel?: "fixed" | "per-token" | "subscription";
  /** Task timeout in seconds (default: 600) */
  timeoutSec?: number;
  /** Default capability used by the canonical Paperclip hiring adapter. */
  capabilityRequested?: string;
  /** Price offered for each hiring. Defaults to the selected agent's base price. */
  price?: string;
  /** Poll interval for the hiring lifecycle in milliseconds (default: 2000). */
  pollIntervalMs?: number;
  /** Agrenting delivery mode for canonical Paperclip runs. */
  deliveryMode?: "output" | "push";
  /** Repository URL used for push delivery. */
  repoUrl?: string;
  /** How instructions are handled: "managed" (uploaded to Agrenting) or "inline" (passed in task context) */
  instructionsBundleMode?: "managed" | "inline";
}

/** Result of executing a task via the Agrenting adapter */
export interface AgrentingExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  taskId?: string;
  durationMs?: number;
}

/** Task status as returned by the Agrenting API */
export type AgrentingTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

/** Task payload from Agrenting API */
export interface AgrentingTask {
  id: string;
  status: AgrentingTaskStatus;
  client_agent_id: string;
  provider_agent_id: string;
  capability: string;
  input: string;
  output?: string;
  error_reason?: string;
  progress_percent?: number;
  progress_message?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

/** Marketplace agent info returned by discover endpoint */
export interface AgentInfo {
  id: string;
  did: string;
  name: string;
  description?: string;
  capabilities: string[];
  price_per_task?: string;
  min_price?: string;
  max_price?: string;
  reputation?: number;
  total_tasks?: number;
  success_rate?: number;
  avatar_url?: string;
}

/** Platform balance from ledger — available, escrowed, and total amounts */
export interface BalanceInfo {
  available: string;
  escrow: string;
  total: string;
  currency?: string;
}

/** Payment info for a task — escrow lock and transaction details */
export interface PaymentInfo {
  id: string;
  task_id: string;
  amount: string;
  currency: string;
  status: string;
  payment_type?: string;
  created_at: string;
  transaction_hash?: string;
}

/** Ledger transaction record */
export interface TransactionInfo {
  id: string;
  type: string;
  amount: string;
  currency: string;
  status: string;
  created_at: string;
  task_id?: string;
  description?: string;
}

/** Options for marketplace agent discovery */
export interface DiscoverAgentsOptions {
  capability?: string;
  minPrice?: number;
  maxPrice?: number;
  minReputation?: number;
  sortBy?: string;
  limit?: number;
}

/** Options for creating a task payment to lock escrow funds */
export interface CreateTaskPaymentOptions {
  cryptoCurrency?: string;
  paymentType?: string;
}

/** Full agent profile returned by GET /api/v1/agents/:did */
export interface AgentProfile {
  id: string;
  did: string;
  name: string;
  description?: string;
  capabilities: string[];
  pricing_tiers?: Array<{
    model: string;
    price_per_task?: string;
    price_per_token?: string;
    monthly_price?: string;
  }>;
  pricing_model?: "fixed" | "per-token" | "subscription";
  base_price?: string;
  reviews?: {
    average_rating: number;
    total_reviews: number;
  };
  reputation_score?: number | string;
  total_earnings?: string;
  verified?: boolean;
  response_time_avg?: number;
  availability_status?: "available" | "busy" | "offline";
  availability?: string;
  status?: string;
  success_rate?: number;
  total_tasks_completed?: number;
  metadata?: Record<string, unknown>;
  avatar_url?: string;
  created_at?: string;
}

/** Result of hiring an agent via POST /api/v1/agents/:did/hire */
export interface HireAgentResult {
  hiring: Hiring;
  config: {
    agentDid: string;
    pricingModel: string;
    basePrice: string;
    capabilities: string[];
    hiringId: string;
    metadata?: Record<string, unknown>;
  };
}

/** Canonical payload required by POST /api/v1/agents/:did/hire. */
export interface HireAgentOptions {
  taskDescription: string;
  capabilityRequested: string;
  price: string | number;
  repoUrl?: string;
  repoAccessToken?: string;
  deliveryMode?: "output" | "push";
  clientIdempotencyKey?: string;
  taskInput?: Record<string, unknown>;
  clientMessage?: string;
}

export type HiringStatus =
  | "pending_payment"
  | "paid"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "disputed"
  | "refunded"
  | (string & {});

/** Hiring record returned by the canonical Agrenting hiring REST API. */
export interface Hiring {
  id: string;
  status: HiringStatus;
  final?: boolean;
  agent_id?: string;
  agent_did?: string;
  client_agent_id?: string;
  agent?: {
    id: string;
    did: string;
    name: string;
    category?: string;
    capabilities?: string[];
    base_price?: string;
    reputation_score?: string;
    status?: string;
  } | null;
  price?: string | null;
  capability_requested?: string;
  task_description?: string;
  delivery_mode?: "output" | "push" | string;
  pricing_model?: string;
  task_input?: Record<string, unknown>;
  task_output?: Record<string, unknown> | string | null;
  failed_reason?: string | null;
  repo_url?: string | null;
  messages?: HiringMessage[];
  artifacts?: Array<Record<string, unknown>>;
  started_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  deadline_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Paginated response returned by GET /api/v1/hirings. */
export interface HiringListResult {
  hirings: Hiring[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

/** Options for sending a message to a task */
export interface SendMessageOptions {
  message: string;
  messageType?: "instruction" | "feedback" | "question";
}

/** Result of sending a message to a task */
export interface SendMessageResult {
  message_id: string;
  task_id: string;
  sent_at: string;
}

/** Task message for bidirectional communication */
export interface TaskMessage {
  id: string;
  task_id: string;
  content: string;
  message_type: "instruction" | "feedback" | "question";
  sender_agent_did?: string;
  sender_user_id?: string;
  sender_name?: string;
  created_at: string;
}

/** Result of reassigning a task to a different agent */
export interface ReassignTaskResult {
  task_id: string;
  previous_agent_did: string;
  new_agent_did: string;
  new_provider_agent_id?: string;
  status?: string;
  reassigned_at?: string;
}

/** Hiring message for communication with hired agent */
export interface HiringMessage {
  id: string;
  hiring_id?: string;
  sender_agent_id?: string;
  sender_type?: string;
  content: string;
  created_at?: string;
  inserted_at?: string;
  sender_name?: string;
}

/** Capability returned by GET /api/v1/capabilities */
export interface Capability {
  name: string;
  description?: string;
  category?: string;
  agent_count?: number;
  avg_price?: string;
}

/** Options for auto-selecting an agent */
export interface AutoSelectOptions {
  capability: string;
  taskDescription: string;
  maxPrice?: string;
  minReputation?: number;
  sortBy?: "reputation_score" | "base_price" | "availability";
  preferAvailable?: boolean;
}

/** Options for retrying a hiring */
export interface RetryHiringOptions {
  reason?: string;
}
