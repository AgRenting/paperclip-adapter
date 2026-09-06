import { createHash } from "node:crypto";
import type {
  AdapterConfigSchema,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterSessionCodec,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { AgrentingClient } from "./client.js";
import type {
  AgentProfile,
  AgrentingAdapterConfig,
  Hiring,
  HiringArtifact,
  HiringQuestion,
  HireAgentOptions,
} from "./types.js";

export const type = "agrenting";
export const label = "Agrenting";

export const agentConfigurationDoc = `# agrenting agent configuration

Adapter: agrenting

Use when:
- A Paperclip agent should delegate each heartbeat to a remote agent hired from Agrenting.
- The operator has an Agrenting user API token and sufficient ledger balance.

Core fields:
- agrentingUrl (required): Agrenting base URL, normally https://agrenting.com
- apiKey (required, secret): Agrenting user API token (ap_...)
- agentDid (required): DID of the marketplace agent to hire
- capabilityRequested (optional): defaults to the first capability on the agent profile
- price (optional): defaults to the agent's current base price
- timeoutSec (optional): maximum time to poll a hiring, default 600
- pollIntervalMs (optional): hiring status poll interval, default 2000
- deliveryMode (optional): output by default; push requires repository access
- repoUrl (optional): repository URL used only when deliveryMode is push

Recommended API-key scopes:
- agents:discover, agents:read, hire:create, hirings:read, hirings:cancel
- add balance:read and artifacts:read when sharing the key with Apps/Claude
- deposits:create and account:read/account:write are optional elevated scopes
- set max_price_per_hire on the key to cap paid actions

Execution:
- Each new Paperclip task execution creates one canonical Agrenting hiring.
- Recovery runs resume or replay the original hiring from persisted session state.
- The Paperclip run id is sent as client_idempotency_key so safe retries deduplicate.
- Paperclip polls the hiring until it completes, fails, is cancelled, or times out.
- Push delivery can use a repository URL from Paperclip and an Agrenting-stored
  GitHub token. The adapter never stores a repository token in agent config.
`;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "disputed",
  "refunded",
]);
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_TASK_DESCRIPTION_LENGTH = 5_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configFrom(raw: Record<string, unknown>): AgrentingAdapterConfig {
  return {
    agrentingUrl: nonEmpty(raw.agrentingUrl) ?? "https://agrenting.com",
    apiKey: nonEmpty(raw.apiKey) ?? "",
    agentDid: nonEmpty(raw.agentDid) ?? "",
    capabilityRequested: nonEmpty(raw.capabilityRequested) ?? undefined,
    price: nonEmpty(raw.price) ?? undefined,
    timeoutSec: positiveNumber(raw.timeoutSec, DEFAULT_TIMEOUT_SEC),
    pollIntervalMs: positiveNumber(
      raw.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS
    ),
    deliveryMode: raw.deliveryMode === "push" ? "push" : "output",
    repoUrl: nonEmpty(raw.repoUrl) ?? undefined,
  };
}

function taskDescriptionFrom(ctx: AdapterExecutionContext): string {
  const context = ctx.context;
  const title =
    nonEmpty(context.taskTitle) ??
    nonEmpty(context.issueTitle) ??
    nonEmpty(context.title);
  const body =
    nonEmpty(context.paperclipTaskMarkdown) ??
    nonEmpty(context.taskBody) ??
    nonEmpty(context.taskDescription) ??
    nonEmpty(context.issueDescription) ??
    nonEmpty(context.prompt) ??
    nonEmpty(context.input);

  let description = [title, body].filter(Boolean).join("\n\n").trim();
  if (!description) {
    description = `Continue the assigned Paperclip work for ${ctx.agent.name}.`;
  }
  if (description.length <= MAX_TASK_DESCRIPTION_LENGTH) return description;
  return `${description.slice(0, MAX_TASK_DESCRIPTION_LENGTH - 32)}\n\n[truncated by Paperclip adapter]`;
}

function capabilityFrom(
  config: AgrentingAdapterConfig,
  context: Record<string, unknown>,
  profile: AgentProfile
): string | null {
  return (
    nonEmpty(config.capabilityRequested) ??
    nonEmpty(context.capabilityRequested) ??
    nonEmpty(context.capability) ??
    profile.capabilities.find((capability) => capability.trim().length > 0) ??
    null
  );
}

function priceFrom(
  config: AgrentingAdapterConfig,
  context: Record<string, unknown>,
  profile: AgentProfile
): string | null {
  return (
    nonEmpty(config.price) ??
    nonEmpty(context.price) ??
    nonEmpty(context.maxPrice) ??
    nonEmpty(profile.base_price)
  );
}

function repoUrlFrom(ctx: AdapterExecutionContext): string | undefined {
  const workspace = asRecord(ctx.context.paperclipWorkspace);
  return (
    nonEmpty(configFrom(ctx.config).repoUrl) ??
    nonEmpty(workspace?.repoUrl) ??
    undefined
  );
}

function taskInputFrom(ctx: AdapterExecutionContext): Record<string, unknown> {
  const input: Record<string, unknown> = {
    paperclip_run_id: ctx.runId,
    paperclip_agent_id: ctx.agent.id,
    paperclip_company_id: ctx.agent.companyId,
  };
  const mappings: Array<[string, unknown]> = [
    ["paperclip_issue_id", ctx.context.issueId ?? ctx.context.taskId],
    ["paperclip_project_id", ctx.context.projectId],
    ["paperclip_wake_reason", ctx.context.wakeReason],
  ];
  for (const [key, value] of mappings) {
    const normalized = nonEmpty(value);
    if (normalized) input[key] = normalized;
  }
  const wake = asRecord(ctx.context.paperclipWake);
  if (wake) input.paperclip_wake = wake;
  return input;
}

function artifactCompletionText(hiring: Hiring): string | null {
  const artifacts = hiring.artifacts ?? [];
  if (artifacts.length === 0) return null;
  const names = artifacts
    .map((artifact) => nonEmpty(artifact.name))
    .filter((name): name is string => Boolean(name));
  const noun = artifacts.length === 1 ? "artifact" : "artifacts";
  const suffix = names.length > 0 ? `: ${names.join(", ")}` : "";
  return `Agrenting hiring ${hiring.id} completed with ${artifacts.length} ${noun}${suffix}.`;
}

function outputText(hiring: Hiring): string {
  const output = hiring.task_output;
  if (typeof output === "string" && output.trim()) return output;
  const record = asRecord(output);
  if (record) {
    for (const key of ["result", "output", "text", "summary"]) {
      const direct = nonEmpty(record[key]);
      if (direct) return direct;
    }
    if (Object.keys(record).length === 0) {
      return artifactCompletionText(hiring) ?? `Agrenting hiring ${hiring.id} completed.`;
    }
    return JSON.stringify(record, null, 2);
  }
  return artifactCompletionText(hiring) ?? `Agrenting hiring ${hiring.id} completed.`;
}

function artifactResults(
  artifacts: HiringArtifact[] | undefined,
  baseUrl: string
): Array<HiringArtifact & { download_url: string }> {
  const origin = new URL(`${baseUrl.replace(/\/+$/, "")}/`);

  return (artifacts ?? []).map((artifact) => ({
    ...artifact,
    download_url: authenticatedArtifactUrl(artifact, origin),
  }));
}

function authenticatedArtifactUrl(artifact: HiringArtifact, origin: URL): string {
  const canonical = new URL(
    `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`,
    origin
  );
  if (!artifact.download_url) return canonical.toString();

  try {
    const supplied = new URL(artifact.download_url, origin);
    return supplied.origin === origin.origin ? supplied.toString() : canonical.toString();
  } catch {
    return canonical.toString();
  }
}

function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "Agrenting hiring completed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultForFailure(
  hiring: Hiring,
  message: string,
  baseUrl: string,
  openQuestions: HiringQuestion[]
): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: message,
    errorCode: `agrenting_hiring_${hiring.status}`,
    provider: "agrenting",
    biller: "agrenting",
    sessionParams: { hiringId: hiring.id, recoveryRequired: false },
    sessionDisplayId: hiring.id,
    resultJson: {
      hiringId: hiring.id,
      status: hiring.status,
      failedReason: hiring.failed_reason ?? null,
      artifacts: artifactResults(hiring.artifacts, baseUrl),
      openQuestions,
    },
  };
}

function pendingCreation(
  agentDid: string,
  request: HireAgentOptions,
  apiKey: string
): Record<string, unknown> {
  const serialized = JSON.stringify(request);
  // Auth config never enters a request snapshot. If task/repository context
  // contains credential material, retain only the key and require reconciliation.
  const sensitive = serialized.includes(apiKey) ||
    /Bearer\s+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|ap_[A-Za-z0-9]{16,}|https?:\/\/[^/\s"]*@/i.test(serialized) ||
    /"[^" ]*(?:token|secret|password|authorization|api[_-]?key)[^" ]*"\s*:/i.test(serialized);
  return {
    idempotencyKey: request.clientIdempotencyKey,
    agentDid,
    ...(sensitive ? { manualOnly: true } : { request: JSON.parse(serialized) }),
  };
}

function requestFromRecovery(pending: Record<string, unknown>): HireAgentOptions | null {
  const request = asRecord(pending.request);
  if (pending.manualOnly || !request ||
      !nonEmpty(pending.agentDid) || !nonEmpty(pending.idempotencyKey) ||
      request.clientIdempotencyKey !== pending.idempotencyKey ||
      !nonEmpty(request.taskDescription) || !nonEmpty(request.capabilityRequested) ||
      !(typeof request.price === "string" || typeof request.price === "number") ||
      !(request.deliveryMode === "output" || request.deliveryMode === "push") ||
      (request.repoUrl !== undefined && typeof request.repoUrl !== "string") ||
      (request.taskInput !== undefined && !asRecord(request.taskInput))) return null;
  const allowed = new Set(["taskDescription", "capabilityRequested", "price", "deliveryMode", "clientIdempotencyKey", "taskInput", "repoUrl"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) return null;
  return request as unknown as HireAgentOptions;
}

/** Canonical Paperclip ServerAdapterModule execution entry point. */
export async function executePaperclip(
  ctx: AdapterExecutionContext
): Promise<AdapterExecutionResult> {
  const config = configFrom(ctx.config);
  if (!config.apiKey || !config.agentDid) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "agrenting_config_invalid",
      errorMessage: "Agrenting requires apiKey and agentDid.",
    };
  }

  const priorSession = asRecord(ctx.runtime.sessionParams);
  const priorHiringId = nonEmpty(priorSession?.hiringId);
  // Old sessions stored only the display ID; inspect those before spending too.
  let hiringId = priorSession?.recoveryRequired !== false ? priorHiringId : null;
  let pendingCreate = priorSession?.recoveryRequired === true && !hiringId
    ? asRecord(priorSession.pendingCreate) ?? { manualOnly: true } : null;
  let hiring: Hiring | undefined;
  let offeredPrice: string | undefined;
  let legacyTerminalResult = false;
  const credentialFingerprint = createHash("sha256").update(config.apiKey).digest("hex");
  let recoveryFingerprint = hiringId || pendingCreate
    ? nonEmpty(priorSession?.credentialFingerprint) ?? credentialFingerprint
    : credentialFingerprint;
  let recoveryUrl = hiringId || pendingCreate
    ? nonEmpty(priorSession?.agrentingUrl) ?? config.agrentingUrl
    : config.agrentingUrl;
  const sessionForRecovery = (): Record<string, unknown> => ({
    ...(hiringId ? { hiringId } : {}),
    ...(pendingCreate ? { pendingCreate } : {}),
    recoveryRequired: true,
    agrentingUrl: recoveryUrl,
    credentialFingerprint: recoveryFingerprint,
  });
  const openQuestions = new Map<string, HiringQuestion>();
  const client = new AgrentingClient(config);
  try {
    if (hiringId || pendingCreate) {
      if (new URL(recoveryUrl).href.replace(/\/+$/, "") !== new URL(config.agrentingUrl).href.replace(/\/+$/, "") ||
          recoveryFingerprint !== credentialFingerprint) {
        throw new Error("Restore the original Agrenting URL and credential to reconcile the saved hiring before creating another.");
      }
    }
    if (pendingCreate && !hiringId) {
      const request = requestFromRecovery(pendingCreate);
      if (!request) {
        throw new Error("Manual reconciliation required for the original hiring idempotency key; no replacement was created.");
      }
      offeredPrice = String(request.price);
      const recovered = await client.hireAgent(String(pendingCreate.agentDid), request);
      hiring = recovered.hiring;
      hiringId = hiring.id;
      pendingCreate = null;
    } else if (hiringId) {
      hiring = await client.getHiring(hiringId);
      // Older sessions do not say whether a terminal result was reported. Read
      // it once without creating a replacement or booking the same cost twice.
      legacyTerminalResult = priorSession?.recoveryRequired !== true &&
        TERMINAL_STATUSES.has(hiring.status);
      await ctx.onLog("stdout", `[agrenting] Resuming hiring ${hiringId} with status ${hiring.status}\n`);
    }

    if (!hiring) {
      const profile = await client.getAgentProfile(config.agentDid);
      const capability = capabilityFrom(config, ctx.context, profile);
      const price = priceFrom(config, ctx.context, profile);
      offeredPrice = price ?? undefined;
      if (!capability) {
        throw new Error(
          "No capabilityRequested was configured and the Agrenting agent profile has no capabilities."
        );
      }
      if (!price) {
        throw new Error(
          "No price was configured and the Agrenting agent profile has no base_price."
        );
      }

      const taskDescription = taskDescriptionFrom(ctx);
      await ctx.onLog(
        "stdout",
        `[agrenting] Hiring ${config.agentDid} for ${capability} at ${price}\n`
      );
      const request: HireAgentOptions = {
        taskDescription,
        capabilityRequested: capability,
        price,
        deliveryMode: config.deliveryMode,
        clientIdempotencyKey: ctx.runId,
        taskInput: taskInputFrom(ctx),
        repoUrl: repoUrlFrom(ctx),
      };
      pendingCreate = pendingCreation(config.agentDid, request, config.apiKey);
      recoveryUrl = config.agrentingUrl;
      recoveryFingerprint = credentialFingerprint;
      const created = await client.hireAgent(config.agentDid, request);
      hiring = created.hiring;
      hiringId = hiring.id;
      pendingCreate = null;
      recoveryUrl = config.agrentingUrl;
      await ctx.onMeta?.({
        adapterType: type,
        command: "POST /api/v1/agents/:did/hire",
        context: { hiringId, agentDid: config.agentDid, capability, price },
      });
      await ctx.onLog(
        "stdout",
        `[agrenting] Hiring ${hiringId} created with status ${created.hiring.status}\n`
      );
    }
    // The ID is saved before log/meta hooks and before any polling can fail.
    const activeHiringId = hiring.id;
    const timeoutMs = (config.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1_000;
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    let lastStatus = hiring.status;
    const recordOpenQuestions = async (snapshot: Hiring): Promise<void> => {
      for (const question of snapshot.open_questions ?? []) {
        if (!question.question_id || openQuestions.has(question.question_id)) continue;
        openQuestions.set(question.question_id, question);
        await ctx.onLog(
          "stderr",
          `[agrenting] Open question ${question.question_id}: ${question.content}\n`
        );
      }
    };

    await recordOpenQuestions(hiring);

    while (!TERMINAL_STATUSES.has(hiring.status) && Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      hiring = await client.getHiring(activeHiringId);
      await recordOpenQuestions(hiring);
      if (hiring.status !== lastStatus) {
        lastStatus = hiring.status;
        await ctx.onLog(
          "stdout",
          `[agrenting] Hiring ${hiringId} is ${hiring.status}\n`
        );
      }
    }

    if (!TERMINAL_STATUSES.has(hiring.status)) {
      try {
        hiring = await client.cancelHiring(activeHiringId);
        await recordOpenQuestions(hiring);
        await ctx.onLog(
          "stderr",
          `[agrenting] Hiring ${hiringId} timed out; cancellation returned status ${hiring.status}\n`
        );
      } catch (cancelError) {
        await ctx.onLog(
          "stderr",
          `[agrenting] Hiring ${hiringId} timed out; cancellation failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}\n`
        );
        try {
          const reconciled = await client.getHiring(activeHiringId);
          await recordOpenQuestions(reconciled);
          if (TERMINAL_STATUSES.has(reconciled.status)) {
            hiring = reconciled;
          }
        } catch {
          // The timeout remains indeterminate when neither cancellation nor a
          // final status read can confirm the remote hiring's outcome.
        }
      }
      if (!TERMINAL_STATUSES.has(hiring.status)) {
        return {
          exitCode: null,
          signal: null,
          timedOut: true,
          errorCode: "agrenting_hiring_timeout",
          errorMessage: `Agrenting hiring ${hiringId} timed out after ${config.timeoutSec ?? DEFAULT_TIMEOUT_SEC}s.`,
          provider: "agrenting",
          biller: "agrenting",
          sessionParams: sessionForRecovery(),
          sessionDisplayId: hiringId,
          resultJson: {
            hiringId,
            status: hiring.status,
            openQuestions: Array.from(openQuestions.values()),
          },
        };
      }
    }

    if (hiring.status !== "completed") {
      return resultForFailure(
        hiring,
        hiring.failed_reason ?? `Agrenting hiring ended with status ${hiring.status}.`,
        config.agrentingUrl,
        Array.from(openQuestions.values())
      );
    }

    const output = outputText(hiring);
    await ctx.onLog("stdout", `${output}\n`);
    const numericPrice = Number(hiring.price ?? offeredPrice);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "agrenting",
      biller: "agrenting",
      billingType: "fixed",
      costUsd: !legacyTerminalResult && Number.isFinite(numericPrice) ? numericPrice : null,
      sessionParams: { hiringId, recoveryRequired: false },
      sessionDisplayId: hiringId,
      summary: firstLine(output),
      resultJson: {
        hiringId,
        status: hiring.status,
        taskOutput: hiring.task_output ?? null,
        artifacts: artifactResults(hiring.artifacts, config.agrentingUrl),
        openQuestions: Array.from(openQuestions.values()),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const transient = /\b(429|5\d\d)\b|rate.?limit|temporar|timeout/i.test(message);
    await ctx.onLog("stderr", `[agrenting] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: pendingCreate && !requestFromRecovery(pendingCreate)
        ? "agrenting_hiring_reconciliation_required" : "agrenting_hiring_failed",
      errorFamily: transient && (!pendingCreate || requestFromRecovery(pendingCreate))
        ? "transient_upstream" : null,
      errorMessage: message,
      provider: "agrenting",
      biller: "agrenting",
      ...(hiringId || pendingCreate ? {
        sessionParams: sessionForRecovery(),
        sessionDisplayId: hiringId,
        resultJson: {
          hiringId,
          status: hiring?.status ?? "unknown",
          openQuestions: Array.from(openQuestions.values()),
        },
      } : {}),
    };
  }
}

function summarizeChecks(
  checks: AdapterEnvironmentCheck[]
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

/** Canonical structured environment test used by Paperclip. */
export async function testPaperclipEnvironment(
  ctx: AdapterEnvironmentTestContext
): Promise<AdapterEnvironmentTestResult> {
  const config = configFrom(ctx.config);
  const checks: AdapterEnvironmentCheck[] = [];

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(config.agrentingUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      parsedUrl = null;
    }
  } catch {
    parsedUrl = null;
  }
  if (!parsedUrl) {
    checks.push({
      code: "agrenting_url_invalid",
      level: "error",
      message: "agrentingUrl must be an http:// or https:// URL.",
    });
  }
  if (!config.apiKey) {
    checks.push({
      code: "agrenting_api_key_missing",
      level: "error",
      message: "Agrenting requires a user API token.",
      hint: "Create an ap_... token in Agrenting and store it as a Paperclip secret.",
    });
  }
  if (!config.agentDid) {
    checks.push({
      code: "agrenting_agent_did_missing",
      level: "error",
      message: "Agrenting requires agentDid.",
    });
  }

  if (!checks.some((check) => check.level === "error")) {
    const client = new AgrentingClient(config);
    let connectionOk = false;
    try {
      await client.listHirings({ limit: 1 });
      connectionOk = true;
      checks.push({
        code: "agrenting_connection_ok",
        level: "info",
        message: "Connected to the authenticated Agrenting hiring API.",
      });
    } catch (error) {
      checks.push({
        code: "agrenting_connection_failed",
        level: "error",
        message: "Could not access the authenticated Agrenting hiring API.",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (connectionOk) {
      try {
        const profile = await client.getAgentProfile(config.agentDid);
        checks.push({
          code: "agrenting_agent_profile_ok",
          level: "info",
          message: `Found Agrenting agent ${profile.name} (${profile.did}).`,
          detail: `${profile.capabilities.length} capabilities; base price ${profile.base_price ?? "not reported"}.`,
        });
      } catch (error) {
        checks.push({
          code: "agrenting_agent_profile_failed",
          level: "error",
          message: `Could not load Agrenting agent ${config.agentDid}.`,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeChecks(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

export function getPaperclipConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "agrentingUrl",
        label: "Agrenting URL",
        type: "text",
        required: true,
        default: "https://agrenting.com",
        hint: "Base URL of the Agrenting platform.",
      },
      {
        key: "apiKey",
        label: "API token",
        type: "text",
        required: true,
        hint: "Agrenting user API token (ap_...). Stored as a Paperclip secret.",
        meta: { secret: true },
      },
      {
        key: "agentDid",
        label: "Agent DID",
        type: "text",
        required: true,
        hint: "Marketplace agent DID, for example did:agrenting:code-reviewer.",
      },
      {
        key: "capabilityRequested",
        label: "Capability",
        type: "text",
        hint: "Optional default. Falls back to the first capability on the agent profile.",
      },
      {
        key: "price",
        label: "Price per hiring (USD)",
        type: "text",
        hint: "Optional. Falls back to the agent's current base price.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "pollIntervalMs",
        label: "Poll interval milliseconds",
        type: "number",
        default: DEFAULT_POLL_INTERVAL_MS,
      },
      {
        key: "repoUrl",
        label: "Repository URL",
        type: "text",
        hint: "Optional push target. Push delivery uses a GitHub token already stored in Agrenting.",
      },
      {
        key: "deliveryMode",
        label: "Delivery mode",
        type: "select",
        default: "output",
        options: [
          { value: "output", label: "Return output" },
          { value: "push", label: "Push to repository" },
        ],
        hint: "Use output unless the hiring also has repository credentials.",
      },
    ],
  };
}

type CompatibilitySessionCodec = AdapterSessionCodec & {
  encode(state: unknown): string;
  decode(blob: string | null | undefined): unknown;
};

export const paperclipSessionCodec: CompatibilitySessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (typeof raw === "string") {
      try {
        return asRecord(JSON.parse(raw));
      } catch {
        return null;
      }
    }
    return asRecord(raw);
  },
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null): string | null {
    return nonEmpty(params?.hiringId);
  },
  encode(state: unknown): string {
    return JSON.stringify(state ?? null);
  },
  decode(blob: string | null | undefined): unknown {
    if (!blob) return null;
    try {
      return JSON.parse(blob);
    } catch {
      return null;
    }
  },
};

export function createCanonicalServerAdapter() {
  return {
    type,
    execute: executePaperclip,
    testEnvironment: testPaperclipEnvironment,
    sessionCodec: paperclipSessionCodec,
    getConfigSchema: getPaperclipConfigSchema,
    agentConfigurationDoc,
  } satisfies ServerAdapterModule;
}
