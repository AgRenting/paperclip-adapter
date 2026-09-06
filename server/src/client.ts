import type {
  AgrentingAdapterConfig,
  AgrentingTask,
  AgentInfo,
  AgentProfile,
  BalanceInfo,
  HireAgentOptions,
  HireAgentResult,
  PaymentInfo,
  ReassignTaskResult,
  SendMessageOptions,
  SendMessageResult,
  TransactionInfo,
  DiscoverAgentsOptions,
  CreateTaskPaymentOptions,
  Hiring,
  HiringListResult,
  TaskMessage,
  HiringMessage,
  Capability,
  RetryHiringOptions,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const SAFE_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

interface RequestOptions {
  /**
   * Stable key proving that the server can deduplicate this mutation. Unsafe
   * methods are retried only when this key is present.
   */
  idempotencyKey?: string;
}

class NonRetryableAgrentingError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "NonRetryableAgrentingError";
    this.status = status;
  }
}

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

  private headers(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
    };
    if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    // A transport failure after a mutating POST may mean the server already
    // charged or created a resource. Never replay such a request unless the
    // caller supplied a key that the API can use to deduplicate it.
    const canRetry = SAFE_RETRY_METHODS.has(method.toUpperCase()) ||
      Boolean(options.idempotencyKey);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(options.idempotencyKey),
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
          throw new NonRetryableAgrentingError(
            "Agrenting API redirect rejected; configure the canonical marketplace URL.",
            response.status
          );
        }

        if (!response.ok) {
          const text = await response.text();
          const shouldRetry =
            canRetry &&
            ([408, 425, 429].includes(response.status) ||
              response.status >= 500);

          if (shouldRetry && attempt < MAX_RETRIES) {
            clearTimeout(timer);
            // Respect Retry-After header on 429, otherwise use exponential backoff
            const retryAfter = response.headers.get("Retry-After");
            let delayMs = Math.min(1000 * 2 ** attempt, 30_000);
            if (retryAfter) {
              // Retry-After can be seconds (integer) or a date string (HTTP-date)
              const seconds = parseInt(retryAfter, 10);
              if (!Number.isNaN(seconds) && seconds >= 0) {
                delayMs = Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
              } else {
                // Try parsing as HTTP date
                const dateMs = Date.parse(retryAfter);
                if (!Number.isNaN(dateMs)) {
                  delayMs = Math.min(
                    Math.max(0, dateMs - Date.now()),
                    MAX_RETRY_DELAY_MS
                  );
                }
              }
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          throw new NonRetryableAgrentingError(
            `Agrenting API ${response.status}: ${text.slice(0, 500)}`,
            response.status
          );
        }

        const envelope = (await response.json()) as Record<string, unknown>;
        if (Array.isArray(envelope.errors) && envelope.errors.length) {
          throw new NonRetryableAgrentingError(
            `API errors: ${(envelope.errors as string[]).join(", ")}`
          );
        }
        return (envelope.data ?? envelope) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError instanceof NonRetryableAgrentingError) {
          throw lastError;
        }
        if (canRetry && attempt < MAX_RETRIES) {
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
    input: string | Record<string, unknown>;
    /** Max price in USD. If set, the task will have a price for escrow. */
    maxPrice?: string;
    /** Payment type: "crypto" | "escrow" | "nowpayments" */
    paymentType?: string;
    /** Stable key used by Agrenting to deduplicate a retried task creation. */
    idempotencyKey?: string;
  }): Promise<AgrentingTask> {
    const body: Record<string, unknown> = {
      provider_agent_id: params.providerAgentId,
      capability: params.capability,
      input:
        typeof params.input === "string"
          ? { prompt: params.input }
          : params.input,
    };
    if (params.maxPrice) {
      body.max_price = params.maxPrice;
    }
    if (params.paymentType) body.payment_type = params.paymentType;
    const task = await this.request<AgrentingTask & { task_id?: string }>(
      "POST",
      "/api/v1/tasks",
      body,
      { idempotencyKey: params.idempotencyKey }
    );
    const id = task.id ?? task.task_id;
    if (!id) {
      throw new Error("Agrenting returned task data without a task id");
    }
    return {
      ...task,
      id,
      payment: task.payment
        ? this.normalizePayment(task.payment, id)
        : undefined,
    };
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
    try {
      // Payment creation is deliberately not retried: this endpoint predates
      // idempotency headers and a timed-out POST may already have moved funds.
      const payment = await this.request<PaymentInfo>(
        "POST",
        `/api/v1/tasks/${taskId}/payments`,
        body
      );
      return this.normalizePayment(payment, taskId);
    } catch (error) {
      // Reconcile an ambiguous transport/server failure with a read before
      // surfacing the error. This returns the original escrow record when the
      // POST succeeded but its response was lost, without issuing a second
      // charge.
      const status = error instanceof NonRetryableAgrentingError ? error.status : undefined;
      const ambiguous = status === undefined || [408, 425, 429].includes(status) || status >= 500;
      if (ambiguous) {
        try {
          return await this.getTaskPayment(taskId);
        } catch {
          // Preserve the original payment error when reconciliation finds no
          // existing payment (for example, a failed POST).
        }
      }
      throw error;
    }
  }

  /** Get payment info for a task */
  async getTaskPayment(taskId: string): Promise<PaymentInfo> {
    const payment = await this.request<PaymentInfo>(
      "GET",
      `/api/v1/tasks/${taskId}/payments`
    );
    return this.normalizePayment(payment, taskId);
  }

  private normalizePayment(payment: PaymentInfo, taskId: string): PaymentInfo {
    const id = payment.id ?? payment.payment_id;
    if (!id) {
      throw new Error("Agrenting returned payment data without a payment id");
    }
    return {
      ...payment,
      id,
      payment_id: payment.payment_id ?? id,
      task_id: payment.task_id ?? taskId,
      currency: payment.currency ?? "USD",
    };
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

  /** Create a paid hiring for an agent.
   * Agrenting requires a concrete task, capability, and offered price.
   */
  async hireAgent(
    agentDid: string,
    options: HireAgentOptions
  ): Promise<HireAgentResult> {
    const body: Record<string, unknown> = {
      task_description: options.taskDescription,
      capability_requested: options.capabilityRequested,
      price: String(options.price),
      delivery_mode: options.deliveryMode ?? "output",
    };
    if (options.repoUrl) body.repo_url = options.repoUrl;
    if (options.repoAccessToken) body.repo_access_token = options.repoAccessToken;
    if (options.clientIdempotencyKey) {
      body.client_idempotency_key = options.clientIdempotencyKey;
    }
    if (options.taskInput) body.task_input = options.taskInput;
    if (options.clientMessage) body.client_message = options.clientMessage;
    return this.request(
      "POST",
      `/api/v1/agents/${encodeURIComponent(agentDid)}/hire`,
      body,
      { idempotencyKey: options.clientIdempotencyKey }
    );
  }

  /** Send a message to a running task (mid-task instructions, feedback, or questions).
   * Enables bidirectional communication between the Paperclip user and the remote agent.
   */
  async sendMessageToTask(
    taskId: string,
    options: SendMessageOptions
  ): Promise<SendMessageResult> {
    const message = await this.request<{
      id?: string;
      message_id?: string;
      inserted_at?: string;
      sent_at?: string;
    }>("POST", `/api/v1/tasks/${taskId}/messages`, {
      content: options.message,
    });
    return {
      message_id: message.message_id ?? message.id ?? "",
      task_id: taskId,
      sent_at: message.sent_at ?? message.inserted_at ?? new Date().toISOString(),
    };
  }

  /**
   * Task message history is unavailable in the current Agrenting REST API.
   * Kept as an explicit compatibility error so older callers fail locally
   * instead of polling a route that does not exist.
   */
  async getTaskMessages(taskId: string): Promise<TaskMessage[]> {
    throw new Error(
      `Agrenting does not expose task message history for ${taskId}; use hiring messages for marketplace work.`
    );
  }

  /** Reassign a failed or cancelled task to a different agent.
   * If `newAgentDid` is omitted, the platform picks the best available agent.
   */
  async reassignTask(
    taskId: string,
    newAgentDid?: string
  ): Promise<ReassignTaskResult> {
    let providerAgentId: string | undefined;
    if (newAgentDid?.startsWith("did:")) {
      providerAgentId = (await this.getAgentProfile(newAgentDid)).id;
    } else {
      providerAgentId = newAgentDid;
    }
    const body: Record<string, unknown> = {};
    if (providerAgentId) body.provider_agent_id = providerAgentId;
    const task = await this.request<AgrentingTask>(
      "POST",
      `/api/v1/tasks/${taskId}/reassign`,
      body
    );
    return {
      task_id: task.id,
      new_agent_did: newAgentDid,
      new_provider_agent_id: task.provider_agent_id,
      status: task.status,
    };
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
   * The canonical API includes recent messages in GET /api/v1/hirings/:id.
   */
  async getHiringMessages(hiringId: string): Promise<HiringMessage[]> {
    const hiring = await this.getHiring(hiringId);
    return hiring.messages ?? [];
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

  /** Cancel an active hiring.
   * POST /api/v1/hirings/:id/cancel
   */
  async cancelHiring(hiringId: string): Promise<Hiring> {
    return this.request<Hiring>(
      "POST",
      `/api/v1/hirings/${hiringId}/cancel`
    );
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
    if (options.offset) {
      const perPage = options.limit ?? 20;
      params.set("page", String(Math.floor(options.offset / perPage) + 1));
    }
    const query = params.toString() ? `?${params}` : "";
    const result = await this.request<HiringListResult>(
      "GET",
      `/api/v1/hirings${query}`
    );
    return result.hirings;
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
