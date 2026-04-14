import type {
  AgrentingAdapterConfig,
  AgrentingTask,
  AgentInfo,
  AgentProfile,
  BalanceInfo,
  HireAgentResult,
  PaymentInfo,
  ReassignTaskResult,
  SendMessageOptions,
  SendMessageResult,
  TransactionInfo,
  DiscoverAgentsOptions,
  CreateTaskPaymentOptions,
  Hiring,
  TaskMessage,
  HiringMessage,
  Capability,
  RetryHiringOptions,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

/**
 * HTTP client for the Agrenting REST API.
 * Wraps fetch with auth headers and base URL handling.
 */
export class AgrentingClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: AgrentingAdapterConfig) {
    this.baseUrl = config.agrentingUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(),
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          const shouldRetry = response.status === 429 || response.status >= 500;

          if (shouldRetry && attempt < MAX_RETRIES) {
            clearTimeout(timer);
            // Respect Retry-After header on 429, otherwise use exponential backoff
            const retryAfter = response.headers.get("Retry-After");
            let delayMs = Math.min(1000 * 2 ** attempt, 30_000);
            if (retryAfter) {
              // Retry-After can be seconds (integer) or a date string (HTTP-date)
              const seconds = parseInt(retryAfter, 10);
              if (!Number.isNaN(seconds) && seconds > 0) {
                delayMs = seconds * 1000;
              } else {
                // Try parsing as HTTP date
                const dateMs = Date.parse(retryAfter);
                if (!Number.isNaN(dateMs)) {
                  delayMs = Math.max(0, dateMs - Date.now());
                }
              }
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          throw new Error(
            `Agrenting API ${response.status}: ${text.slice(0, 500)}`
          );
        }

        const envelope = (await response.json()) as Record<string, unknown>;
        if (Array.isArray(envelope.errors) && envelope.errors.length) {
          throw new Error(`API errors: ${(envelope.errors as string[]).join(", ")}`);
        }
        return (envelope.data ?? envelope) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          clearTimeout(timer);
          const delayMs = Math.min(1000 * 2 ** attempt, 30_000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }

    // Should never reach here, but satisfy the compiler
    throw lastError ?? new Error("Unexpected retry loop exit");
  }

  /** Submit a new task to Agrenting.
   * When `maxPrice` is set, the task includes pricing info.
   * Call `createTaskPayment` after this to actually lock escrow funds.
   */
  async createTask(params: {
    providerAgentId: string;
    capability: string;
    input: string;
    /** Max price in USD. If set, the task will have a price for escrow. */
    maxPrice?: string;
    /** Payment type: "crypto" | "escrow" | "nowpayments" */
    paymentType?: string;
  }): Promise<AgrentingTask> {
    const body: Record<string, unknown> = {
      provider_agent_id: params.providerAgentId,
      capability: params.capability,
      input: params.input,
    };
    if (params.maxPrice) {
      body.max_price = params.maxPrice;
    }
    return this.request("POST", "/api/v1/tasks", body);
  }

  /** Create a payment for an existing task to lock escrow funds.
   * This is the step that actually deducts funds from the client's balance
   * and places them in escrow for the task.
   */
  async createTaskPayment(
    taskId: string,
    options: CreateTaskPaymentOptions = {}
  ): Promise<PaymentInfo> {
    const body: Record<string, unknown> = {
      task_id: taskId,
    };
    if (options.cryptoCurrency) body.crypto_currency = options.cryptoCurrency;
    if (options.paymentType) body.payment_type = options.paymentType;
    return this.request("POST", `/api/v1/tasks/${taskId}/payments`, body);
  }

  /** Get payment info for a task */
  async getTaskPayment(taskId: string): Promise<PaymentInfo> {
    return this.request("GET", `/api/v1/tasks/${taskId}/payments`);
  }

  /** Get the status and result of a task */
  async getTask(taskId: string): Promise<AgrentingTask> {
    return this.request<AgrentingTask>("GET", `/api/v1/tasks/${taskId}`);
  }

  /** Get task timeline events (progress, attempts, status changes) */
  async getTaskTimeline(taskId: string): Promise<{
    events: Array<{
      event_type: string;
      timestamp: string;
      progress_percent?: number;
      progress_message?: string;
      details?: Record<string, unknown>;
    }>;
  }> {
    return this.request("GET", `/api/v1/tasks/${taskId}/timeline`);
  }

  /** Get attempt history for a task */
  async getTaskAttempts(taskId: string): Promise<{
    attempts: Array<{
      id: string;
      status: string;
      created_at: string;
      completed_at?: string;
      error_reason?: string;
    }>;
  }> {
    return this.request("GET", `/api/v1/tasks/${taskId}/attempts`);
  }

  /** Get current progress of a task */
  async getTaskProgress(taskId: string): Promise<{
    status: string;
    progress_percent: number;
    progress_message?: string;
    updated_at: string;
  }> {
    const task = await this.getTask(taskId);
    return {
      status: task.status,
      progress_percent: task.progress_percent ?? 0,
      progress_message: task.progress_message,
      updated_at: task.updated_at,
    };
  }

  /** Register a webhook to receive task lifecycle events.
   * Sends a flat request body matching the backend's expected shape.
   */
  async registerWebhook(params: {
    callbackUrl: string;
    eventTypes?: string[];
  }): Promise<{
    id: string;
    callback_url: string;
    event_types: string[];
    secret_key: string;
    status: string;
  }> {
    return this.request("POST", "/api/v1/webhooks", {
      callback_url: params.callbackUrl,
      event_types: params.eventTypes ?? [
        "task.created",
        "task.claimed",
        "task.in_progress",
        "task.completed",
        "task.failed",
        "task.cancelled",
      ],
    });
  }

  /** List registered webhooks */
  async listWebhooks(): Promise<
    Array<{
      id: string;
      callback_url: string;
      event_types: string[];
      status: string;
      last_delivery_at?: string;
      failure_count: number;
    }>
  > {
    return this.request("GET", "/api/v1/webhooks");
  }

  /** Delete a registered webhook */
  async deleteWebhook(webhookId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/webhooks/${webhookId}`);
  }

  /** Cancel a task by ID */
  async cancelTask(taskId: string): Promise<AgrentingTask> {
    return this.request("POST", `/api/v1/tasks/${taskId}/cancel`);
  }

  /** Discover marketplace agents available for hire.
   * Filters by capability, price range, reputation, and availability.
   */
  async discoverAgents(
    options: DiscoverAgentsOptions = {}
  ): Promise<AgentInfo[]> {
    const params = new URLSearchParams();
    if (options.capability) params.set("capability", options.capability);
    if (options.minPrice) params.set("min_price", options.minPrice.toFixed(2));
    if (options.maxPrice) params.set("max_price", options.maxPrice.toFixed(2));
    if (options.minReputation)
      params.set("min_reputation", String(options.minReputation));
    if (options.sortBy) params.set("sort_by", options.sortBy);
    if (options.limit) params.set("limit", String(options.limit));

    return this.request<AgentInfo[]>(
      "GET",
      `/api/v1/agents/discover?${params}`
    );
  }

  /** Fetch the current platform balance including available, escrowed, and total. */
  async getBalance(): Promise<BalanceInfo> {
    return this.request("GET", "/api/v1/ledger/balance");
  }

  /** List recent transactions for the authenticated agent. */
  async getTransactions(
    options: { limit?: number; offset?: number; type?: string } = {}
  ): Promise<TransactionInfo[]> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.type) params.set("type", options.type);

    return this.request<TransactionInfo[]>(
      "GET",
      `/api/v1/ledger/transactions?${params}`
    );
  }

  /** Deposit funds into the Agrenting ledger. */
  async deposit(params: {
    amount: string;
    currency?: string;
    paymentMethod?: string;
  }): Promise<{
    transaction_id: string;
    status: string;
    deposit_address?: string;
    payment_url?: string;
  }> {
    return this.request("POST", "/api/v1/ledger/deposit", {
      amount: params.amount,
      currency: params.currency ?? "USD",
      payment_method: params.paymentMethod ?? "crypto",
    });
  }

  /** Withdraw funds from the Agrenting ledger to an external wallet. */
  async withdraw(params: {
    amount: string;
    currency?: string;
    withdrawalAddressId?: string;
  }): Promise<{
    transaction_id: string;
    status: string;
  }> {
    return this.request("POST", "/api/v1/ledger/withdraw", {
      amount: params.amount,
      currency: params.currency ?? "USD",
      withdrawal_address_id: params.withdrawalAddressId,
    });
  }

  /** Create a payment intent for off-platform payment processing. */
  async createPaymentIntent(params: {
    amount: string;
    currency?: string;
    paymentType?: string;
  }): Promise<{
    id: string;
    status: string;
    payment_url?: string;
    address?: string;
  }> {
    return this.request("POST", "/api/v1/payments/create-intent", {
      amount: params.amount,
      currency: params.currency ?? "USD",
      payment_type: params.paymentType ?? "crypto",
    });
  }

  /** Validate connectivity and API key by fetching the account balance */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const data = await this.request<{
        available?: string;
        escrow?: string;
        total?: string;
        currency?: string;
      }>("GET", "/api/v1/ledger/balance");
      return {
        ok: true,
        message: `Connected. Balance: ${data.total ?? data.available ?? "N/A"} ${data.currency ?? "USD"} (Available: ${data.available ?? "N/A"})`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Unknown connection error",
      };
    }
  }

  /** Upload a document (e.g. instructions) to Agrenting.
   * Uses the dedicated uploads endpoint which accepts base64-encoded content,
   * separate from the deal-scoped `/api/v1/documents` endpoint.
   */
  async uploadDocument(params: {
    name: string;
    content: string;
    contentType?: string;
    documentType?: string;
    taskId?: string;
  }): Promise<{
    id: string;
    name: string;
    file_url: string;
    content_type: string;
    file_hash: string;
    document_type: string;
  }> {
    const contentBase64 = Buffer.from(params.content).toString("base64");
    return this.request("POST", "/api/v1/uploads", {
      name: params.name,
      content: contentBase64,
      content_type: params.contentType ?? "text/plain",
      document_type: params.documentType ?? "instructions",
      task_id: params.taskId,
    });
  }

  /** Get the full profile of an agent by DID.
   * Returns capabilities, pricing tiers, reviews, and availability.
   */
  async getAgentProfile(agentDid: string): Promise<AgentProfile> {
    return this.request("GET", `/api/v1/agents/${encodeURIComponent(agentDid)}`);
  }

  /** Hire/bind an agent to your account.
   * Returns adapter config so Paperclip can auto-provision the agent.
   */
  async hireAgent(
    agentDid: string,
    options: { pricingModel?: string } = {}
  ): Promise<HireAgentResult> {
    const body: Record<string, unknown> = {};
    if (options.pricingModel) body.pricing_model = options.pricingModel;
    return this.request(
      "POST",
      `/api/v1/agents/${encodeURIComponent(agentDid)}/hire`,
      body
    );
  }

  /** Send a message to a running task (mid-task instructions, feedback, or questions).
   * Enables bidirectional communication between the Paperclip user and the remote agent.
   */
  async sendMessageToTask(
    taskId: string,
    options: SendMessageOptions
  ): Promise<SendMessageResult> {
    return this.request("POST", `/api/v1/tasks/${taskId}/messages`, {
      message: options.message,
      message_type: options.messageType ?? "instruction",
    });
  }

  /** Get messages for a task.
   * GET /api/v1/tasks/:id/messages
   */
  async getTaskMessages(taskId: string): Promise<TaskMessage[]> {
    return this.request<TaskMessage[]>(
      "GET",
      `/api/v1/tasks/${taskId}/messages`
    );
  }

  /** Reassign a failed or cancelled task to a different agent.
   * If `newAgentDid` is omitted, the platform picks the best available agent.
   */
  async reassignTask(
    taskId: string,
    newAgentDid?: string
  ): Promise<ReassignTaskResult> {
    const body: Record<string, unknown> = {};
    if (newAgentDid) {
      body.new_provider_agent_did = newAgentDid;
    }
    return this.request<ReassignTaskResult>(
      "POST",
      `/api/v1/tasks/${taskId}/reassign`,
      body
    );
  }

  /** List all available capabilities with descriptions and usage stats.
   * GET /api/v1/capabilities
   */
  async listCapabilities(): Promise<Capability[]> {
    return this.request<Capability[]>("GET", "/api/v1/capabilities");
  }

  /** Send a message to a hiring for communication with the hired agent.
   * POST /api/v1/hirings/:id/messages
   */
  async sendMessageToHiring(
    hiringId: string,
    content: string
  ): Promise<HiringMessage> {
    if (content.length > 5000) {
      throw new Error("Message content exceeds 5000 character limit");
    }
    return this.request<HiringMessage>(
      "POST",
      `/api/v1/hirings/${hiringId}/messages`,
      { content }
    );
  }

  /** Get messages for a hiring.
   * GET /api/v1/hirings/:id/messages
   */
  async getHiringMessages(hiringId: string): Promise<HiringMessage[]> {
    return this.request<HiringMessage[]>(
      "GET",
      `/api/v1/hirings/${hiringId}/messages`
    );
  }

  /** Retry a failed hiring.
   * POST /api/v1/hirings/:id/retry
   */
  async retryHiring(
    hiringId: string,
    options: RetryHiringOptions = {}
  ): Promise<Hiring> {
    const body: Record<string, unknown> = {};
    if (options.reason) {
      body.reason = options.reason;
    }
    return this.request<Hiring>(
      "POST",
      `/api/v1/hirings/${hiringId}/retry`,
      body
    );
  }

  /** Get a hiring by ID.
   * GET /api/v1/hirings/:id
   */
  async getHiring(hiringId: string): Promise<Hiring> {
    return this.request<Hiring>("GET", `/api/v1/hirings/${hiringId}`);
  }

  /** List hirings for the authenticated agent.
   * GET /api/v1/hirings
   */
  async listHirings(options: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Hiring[]> {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    const query = params.toString() ? `?${params}` : "";
    return this.request<Hiring[]>("GET", `/api/v1/hirings${query}`);
  }

  /** List agents filtered by capability for auto-select.
   * GET /api/v1/agents?capability=X
   */
  async listAgentsByCapability(capability: string): Promise<AgentProfile[]> {
    return this.request<AgentProfile[]>(
      "GET",
      `/api/v1/agents?capability=${encodeURIComponent(capability)}`
    );
  }
}
