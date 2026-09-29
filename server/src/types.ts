/**
 * Agrenting adapter configuration schema.
 * These fields are rendered in the Paperclip UI when configuring an Agrenting agent.
 */
export interface AgrentingAdapterConfig {
  /** Agrenting platform URL, e.g. https://agrenting.com */
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
  /** "swarm" hires one Agrenting team per allowed run; any other value hires `agentDid`. */
  mode?: "hiring" | "swarm";
  /** Team mode roster, as an object or a JSON string. Use exactly one of roster, savedTeamId or teamListingId. */
  roster?: SwarmRoster | string;
  /** Team mode: id of a team saved at agrenting.com/dashboard/teams. Use exactly one of roster, savedTeamId or teamListingId. */
  savedTeamId?: string;
  /** A listed team's id from GET /api/v1/team_listings. Use exactly one of roster, savedTeamId or teamListingId. */
  teamListingId?: string;
  /** Team mode: highest team total the adapter may create, e.g. "60.00". Required in team mode. */
  maxTotalPrice?: string;
  /** Team mode: wake reasons that may create a paid team (array or comma-separated). */
  swarmCreateWakeReasons?: string[] | string;
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
  input: Record<string, unknown> | string;
  output?: string;
  error_reason?: string;
  progress_percent?: number;
  progress_message?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  payment?: PaymentInfo;
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
  payment_id?: string;
  task_id: string;
  amount: string;
  currency: string;
  status: string;
  payment_type?: string;
  created_at?: string;
  invoice_url?: string | null;
  escrow_held?: boolean;
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
  dispatch_id?: string | null;
  trace_attempt?: number;
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
  open_questions?: HiringQuestion[];
  artifacts?: HiringArtifact[];
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
  previous_agent_did?: string;
  new_agent_did?: string;
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
  kind?: "message" | "question" | "answer" | string;
  reply_to_id?: string | null;
  resolved_at?: string | null;
  content: string;
  created_at?: string;
  inserted_at?: string;
  sender_name?: string;
}

/** Structured, non-blocking agent question exposed by hiring status reads. */
export interface HiringQuestion {
  question_id: string;
  content: string;
  asked_at?: string | null;
}

/** Artifact metadata embedded in a hiring detail response. */
export interface HiringArtifact extends Record<string, unknown> {
  id: string;
  name?: string | null;
  artifact_type?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  download_url?: string;
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

/** One roster slot in Paperclip team-mode config. */
export interface SwarmRosterSlot {
  agentDid: string;
  capability: string;
  price: string;
  note?: string;
}

/** Team-mode roster: one lead and 1-8 members. */
export interface SwarmRoster {
  lead: SwarmRosterSlot;
  members: SwarmRosterSlot[];
}

/** Parsed team-mode settings. Money is held in integer cents. */
export interface SwarmModeConfig {
  roster: SwarmRoster | null;
  savedTeamId: string | null;
  teamListingId: string | null;
  maxTotalPriceCents: number;
  swarmCreateWakeReasons: string[];
}

/** Lead slot sent to POST /api/v1/swarms. */
export interface SwarmLeadBody {
  agent_did: string;
  capability_requested: string;
  price: string;
}

/** Member slot sent to POST /api/v1/swarms. */
export interface SwarmMemberBody extends SwarmLeadBody {
  note?: string;
}

/** Body of POST /api/v1/swarms; the client sends it as {swarm: body}. */
export interface SwarmCreateBody {
  task_description: string;
  task_input?: Record<string, unknown>;
  delivery_mode: "output";
  client_idempotency_key: string;
  total_price: string;
  lead?: SwarmLeadBody;
  members?: SwarmMemberBody[];
  saved_team_id?: string;
  team_listing_id?: string;
  /** The listing's fingerprint as read just before the hire; Agrenting refuses a changed team with 422 listing_changed. */
  team_listing_fingerprint?: string;
}

export type SwarmStatusValue =
  | "planning"
  | "running"
  | "merging"
  | "completed"
  | "failed"
  | "cancelled"
  | (string & {});

/** Open question in the team status shape. */
export interface SwarmQuestion {
  question_id: string;
  content: string;
  asked_at?: string | null;
  hiring_id?: string | null;
  role?: string | null;
  alias?: string | null;
}

export interface SwarmAgentRef {
  did: string;
  name: string;
}

export interface SwarmLeadStatus {
  hiring_id?: string;
  agent?: SwarmAgentRef | null;
  status?: string;
}

export interface SwarmMemberStatus {
  alias: string;
  hiring_id?: string;
  agent?: SwarmAgentRef | null;
  capability?: string | null;
  status: "reserved" | "starting" | "working" | "delivered" | "not_delivered" | (string & {});
  title?: string | null;
}

export interface SwarmDeliverable {
  task_output?: Record<string, unknown> | string | null;
  artifact_ids?: string[];
}

/** Team status shape returned by POST /api/v1/swarms and GET /api/v1/swarms/:id. */
export interface SwarmStatus {
  swarm_id: string;
  status: SwarmStatusValue;
  final?: boolean;
  phase?: "plan" | "members" | "merge" | "done" | (string & {});
  phase_deadline_at?: string | null;
  deadline_at?: string | null;
  partial?: boolean;
  failure_code?: string | null;
  total_price?: string | null;
  held?: string | null;
  charged?: string | null;
  refunded?: string | null;
  plan?: { summary?: string; subtasks?: Array<{ alias: string; title: string }> } | null;
  lead?: SwarmLeadStatus | null;
  members?: SwarmMemberStatus[];
  open_questions?: SwarmQuestion[];
  deliverable?: SwarmDeliverable | null;
}

/** One agent of a saved team in GET /api/v1/saved_teams. */
export interface SavedTeamSlot {
  agent_did: string;
  name?: string;
  capability?: string | null;
  price: string;
  available?: boolean;
  note?: string | null;
}

/** A saved team in GET /api/v1/saved_teams. */
export interface SavedTeam {
  id: string;
  name: string;
  lead: SavedTeamSlot;
  members: SavedTeamSlot[];
  total_price: string;
}

/** A listed team in GET /api/v1/team_listings and GET /api/v1/team_listings/:id. */
export interface TeamListing {
  id: string;
  slug: string;
  name: string;
  total_price: string;
  agent_count: number;
  available: boolean;
  /** Digest of the team's agents, capabilities and shares; absent from older Agrenting servers. */
  fingerprint?: string;
}

/** Why a team create was refused; returned in resultJson. */
export interface SwarmRejection {
  httpStatus: number | null;
  code: string | null;
  message: string;
  details: unknown[];
}

/** Classification of a failed POST /api/v1/swarms. */
export type SwarmCreateFailure =
  | { kind: "definitive"; httpStatus: number; code: string | null; message: string; details: unknown[] }
  | { kind: "conflict"; message: string }
  | { kind: "ambiguous"; message: string };

/** Mutable recovery state of one team-mode run. */
export interface SwarmRunState {
  swarmId: string | null;
  pendingCreate: Record<string, unknown> | null;
  recoveryUrl: string;
  recoveryFingerprint: string;
}
