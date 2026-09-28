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
  SwarmModeConfig,
  SwarmRoster,
  SwarmRosterSlot,
  SwarmCreateBody,
  SwarmLeadBody,
  SwarmMemberBody,
  SwarmCreateFailure,
  SwarmQuestion,
  SwarmStatus,
  SwarmRejection,
  SwarmRunState,
  SavedTeam,
  TeamListing,
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
  return `${description.slice(0, MAX_TASK_DESCRIPTION_LENGTH - 34)}\n\n[truncated by Paperclip adapter]`;
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

/** True when a serialized request may contain credential material. */
function containsCredential(serialized: string, apiKey: string): boolean {
  return serialized.includes(apiKey) ||
    /Bearer\s+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|ap_[A-Za-z0-9]{16,}|https?:\/\/[^/\s"]*@/i.test(serialized) ||
    /"[^" ]*(?:token|secret|password|authorization|api[_-]?key)[^" ]*"\s*:/i.test(serialized);
}

function pendingCreation(
  agentDid: string,
  request: HireAgentOptions,
  apiKey: string
): Record<string, unknown> {
  const serialized = JSON.stringify(request);
  // Auth config never enters a request snapshot. If task/repository context
  // contains credential material, retain only the key and require reconciliation.
  const sensitive = containsCredential(serialized, apiKey);
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
    try {
      await ctx.onLog("stderr", `[agrenting] ${message}\n`);
    } catch {
      // A host logging outage must not discard the original paid-work recovery state.
    }
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

// ── Team (swarm) mode ─────────────────────────────────────────────

export const DEFAULT_SWARM_CREATE_WAKE_REASONS: readonly string[] = ["issue_assigned", "issue_commented"];
const MAX_SWARM_MEMBERS = 8;
const MAX_SWARM_NOTE_LENGTH = 500;

/** Parses a USD amount ("45", "45.5", "45.50" or a number) into integer cents. */
export function priceToCents(value: unknown): number | null {
  const text = typeof value === "number"
    ? (Number.isFinite(value) ? String(value) : "")
    : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function centsToPrice(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function swarmSlotFrom(raw: unknown, label: string): SwarmRosterSlot | string {
  const slot = asRecord(raw);
  if (!slot) return `${label} must be an object with agentDid, capability and price.`;
  const agentDid = nonEmpty(slot.agentDid);
  if (!agentDid) return `${label}.agentDid is required.`;
  const capability = nonEmpty(slot.capability);
  if (!capability) return `${label}.capability is required.`;
  const cents = priceToCents(slot.price);
  if (cents === null) return `${label}.price must be a USD amount such as "15.00".`;
  if (slot.note !== undefined &&
      (typeof slot.note !== "string" || slot.note.length > MAX_SWARM_NOTE_LENGTH)) {
    return `${label}.note must be text of at most 500 characters.`;
  }
  const note = nonEmpty(slot.note);
  return { agentDid, capability, price: centsToPrice(cents), ...(note ? { note } : {}) };
}

function swarmRosterFrom(raw: unknown): SwarmRoster | string {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return "roster must be valid JSON.";
    }
  }
  const roster = asRecord(value);
  if (!roster) return "roster must be an object with lead and members.";
  const lead = swarmSlotFrom(roster.lead, "roster.lead");
  if (typeof lead === "string") return lead;
  if (!Array.isArray(roster.members) || roster.members.length < 1 ||
      roster.members.length > MAX_SWARM_MEMBERS) {
    return "roster.members must list 1 to 8 members.";
  }
  const members: SwarmRosterSlot[] = [];
  for (const [index, entry] of roster.members.entries()) {
    const member = swarmSlotFrom(entry, `roster.members[${index}]`);
    if (typeof member === "string") return member;
    members.push(member);
  }
  return { lead, members };
}

function wakeReasonsFrom(raw: unknown): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const reasons = list
    .map((entry) => nonEmpty(entry))
    .filter((entry): entry is string => entry !== null);
  return reasons.length > 0 ? reasons : [...DEFAULT_SWARM_CREATE_WAKE_REASONS];
}

/** Validates team-mode config. Returns the first problem as an exact sentence. */
export function swarmConfigFrom(
  raw: Record<string, unknown>
): { ok: true; value: SwarmModeConfig } | { ok: false; error: string } {
  const hasRoster = raw.roster !== undefined && raw.roster !== null &&
    !(typeof raw.roster === "string" && raw.roster.trim() === "");
  const savedTeamId = nonEmpty(raw.savedTeamId);
  const teamListingId = nonEmpty(raw.teamListingId);
  if ([hasRoster, savedTeamId !== null, teamListingId !== null].filter(Boolean).length !== 1) {
    return { ok: false, error: "Swarm mode requires exactly one of roster, savedTeamId or teamListingId." };
  }
  const maxTotalPriceCents = priceToCents(raw.maxTotalPrice);
  if (!maxTotalPriceCents) {
    return { ok: false, error: 'Swarm mode requires maxTotalPrice, a USD amount such as "60.00".' };
  }
  let roster: SwarmRoster | null = null;
  if (hasRoster) {
    const parsed = swarmRosterFrom(raw.roster);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    roster = parsed;
  }
  return {
    ok: true,
    value: {
      roster,
      savedTeamId,
      teamListingId,
      maxTotalPriceCents,
      swarmCreateWakeReasons: wakeReasonsFrom(raw.swarmCreateWakeReasons),
    },
  };
}

/** The run's wake reason: context.wakeReason, else context.paperclipWake.reason. */
export function swarmWakeReasonFrom(context: Record<string, unknown>): string | null {
  return nonEmpty(context.wakeReason) ?? nonEmpty(asRecord(context.paperclipWake)?.reason);
}

/** True only when the wake reason is in the configured create list (15.5). */
export function swarmCreateAllowed(reason: string | null, allowed: readonly string[]): boolean {
  return reason !== null && allowed.includes(reason);
}


/** Team task_input: the single-hire IDs without the raw wake payload. */
export function swarmTaskInputFrom(ctx: AdapterExecutionContext): Record<string, unknown> {
  const input = taskInputFrom(ctx);
  delete input.paperclip_wake;
  return input;
}

/** REST slots and the exact total, in cents, of a configured roster. */
export function swarmRosterBody(
  roster: SwarmRoster
): { lead: SwarmLeadBody; members: SwarmMemberBody[]; totalCents: number } {
  const slot = (entry: SwarmRosterSlot): SwarmLeadBody => ({
    agent_did: entry.agentDid,
    capability_requested: entry.capability,
    price: entry.price,
  });
  const members = roster.members.map((member) => ({
    ...slot(member),
    ...(member.note ? { note: member.note } : {}),
  }));
  const totalCents = [roster.lead, ...roster.members]
    .reduce((sum, entry) => sum + (priceToCents(entry.price) ?? 0), 0);
  return { lead: slot(roster.lead), members, totalCents };
}

/** Recovery snapshot of a team create; createdAt is the first attempt's time. */
export function pendingSwarmCreation(
  body: SwarmCreateBody,
  apiKey: string,
  now: Date
): Record<string, unknown> {
  const serialized = JSON.stringify(body);
  return {
    kind: "swarm",
    idempotencyKey: body.client_idempotency_key,
    createdAt: now.toISOString(),
    ...(containsCredential(serialized, apiKey) ? { manualOnly: true } : { request: JSON.parse(serialized) }),
  };
}

/** The exact saved team request, or null when it may not be replayed. */
export function swarmRequestFromRecovery(pending: Record<string, unknown>): SwarmCreateBody | null {
  const request = asRecord(pending.request);
  const key = nonEmpty(pending.idempotencyKey);
  if (pending.kind !== "swarm" || pending.manualOnly || !request || !key ||
      request.client_idempotency_key !== key ||
      !nonEmpty(request.task_description) ||
      request.delivery_mode !== "output" ||
      priceToCents(request.total_price) === null ||
      (request.task_input !== undefined && !asRecord(request.task_input))) return null;
  const hasRoster = asRecord(request.lead) !== null && Array.isArray(request.members);
  const hasSavedTeam = nonEmpty(request.saved_team_id) !== null;
  const hasTeamListing = nonEmpty(request.team_listing_id) !== null;
  if ([hasRoster, hasSavedTeam, hasTeamListing].filter(Boolean).length !== 1) return null;
  if (hasTeamListing && ["lead", "members", "saved_team_id"].some((field) => field in request)) return null;
  const allowed = new Set([
    "task_description", "task_input", "delivery_mode", "client_idempotency_key",
    "total_price", "lead", "members", "saved_team_id", "team_listing_id",
  ]);
  if (Object.keys(request).some((field) => !allowed.has(field))) return null;
  return request as unknown as SwarmCreateBody;
}


export const SWARM_REPLAY_WINDOW_MS = 30 * 60 * 1_000;

/** True only within 30 minutes (inclusive) after the first create attempt. */
export function swarmReplayAllowed(createdAt: unknown, now: Date): boolean {
  const started = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(started)) return false;
  const elapsed = now.getTime() - started;
  return elapsed >= 0 && elapsed <= SWARM_REPLAY_WINDOW_MS;
}

/** Sorts a failed POST /api/v1/swarms into definitive, conflict or ambiguous (15.4). */
export function classifySwarmCreateError(error: unknown): SwarmCreateFailure {
  const facts = asRecord(error) ?? {};
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = typeof facts.status === "number" ? facts.status : null;
  const code = typeof facts.code === "string" ? facts.code : null;
  if (httpStatus === null || [408, 425, 429].includes(httpStatus) || httpStatus >= 500) {
    return { kind: "ambiguous", message };
  }
  if (httpStatus === 409 && code === "IDEMPOTENCY_CONFLICT") return { kind: "conflict", message };
  return {
    kind: "definitive",
    httpStatus,
    code,
    message: typeof facts.apiMessage === "string" ? facts.apiMessage : message,
    details: Array.isArray(facts.details) ? facts.details : [],
  };
}

/** A single-hire session that must be finished before team mode may spend. */
export function hiringRecoveryPending(prior: Record<string, unknown>): boolean {
  if (prior.mode === "swarm") return false;
  if (prior.recoveryRequired === true) return true;
  return prior.recoveryRequired !== false && nonEmpty(prior.hiringId) !== null;
}

/** A team session that must be finished before hiring mode may spend. */
export function swarmRecoveryPending(prior: Record<string, unknown>): boolean {
  return prior.mode === "swarm" && prior.recoveryRequired === true;
}


const SWARM_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function swarmFinal(status: SwarmStatus): boolean {
  return status.final === true || SWARM_TERMINAL_STATUSES.has(status.status);
}

/** Allowlisted open questions of the lead and every member (15.6). */
export function swarmOpenQuestions(status: SwarmStatus): SwarmQuestion[] {
  return (status.open_questions ?? [])
    .filter((question) => nonEmpty(question?.question_id) !== null && typeof question.content === "string")
    .map((question) => ({
      question_id: question.question_id,
      content: question.content,
      asked_at: question.asked_at ?? null,
      hiring_id: question.hiring_id ?? null,
      role: question.role ?? null,
      alias: question.alias ?? null,
    }));
}

/** costUsd = the team's charged amount (15.2). */
export function swarmCostUsd(status: SwarmStatus): number | null {
  const cents = priceToCents(status.charged);
  return cents === null ? null : cents / 100;
}

export function swarmDeliverableText(status: SwarmStatus): string {
  const output = status.deliverable?.task_output;
  if (typeof output === "string" && output.trim()) return output;
  const record = asRecord(output);
  if (record) {
    for (const key of ["result", "output", "text", "summary"]) {
      const direct = nonEmpty(record[key]);
      if (direct) return direct;
    }
    if (Object.keys(record).length > 0) return JSON.stringify(record, null, 2);
  }
  const count = status.deliverable?.artifact_ids?.length ?? 0;
  const noun = count === 1 ? "artifact" : "artifacts";
  return count > 0
    ? `Agrenting team ${status.swarm_id} completed with ${count} ${noun}.`
    : `Agrenting team ${status.swarm_id} completed.`;
}

export function swarmResultJson(
  status: SwarmStatus,
  baseUrl: string,
  openQuestions: SwarmQuestion[]
): Record<string, unknown> {
  const origin = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  const deliverable = status.deliverable ?? null;
  return {
    swarmId: status.swarm_id,
    status: status.status,
    phase: status.phase ?? null,
    final: swarmFinal(status),
    partial: status.partial === true,
    failureCode: status.failure_code ?? null,
    totalPrice: status.total_price ?? null,
    charged: status.charged ?? null,
    refunded: status.refunded ?? null,
    deliverable: deliverable
      ? {
          taskOutput: deliverable.task_output ?? null,
          artifacts: (deliverable.artifact_ids ?? []).map((id) => ({
            id,
            download_url: authenticatedArtifactUrl({ id }, origin),
          })),
        }
      : null,
    members: (status.members ?? []).map((member) => ({
      alias: member.alias,
      title: member.title ?? null,
      status: member.status,
    })),
    openQuestions,
  };
}

export function swarmFinalResult(
  status: SwarmStatus,
  baseUrl: string,
  openQuestions: SwarmQuestion[]
): AdapterExecutionResult {
  const base = {
    signal: null,
    timedOut: false,
    provider: "agrenting",
    biller: "agrenting",
    billingType: "fixed" as const,
    costUsd: swarmCostUsd(status),
    sessionParams: { mode: "swarm", swarmId: status.swarm_id, recoveryRequired: false },
    sessionDisplayId: status.swarm_id,
    resultJson: swarmResultJson(status, baseUrl, openQuestions),
  };
  if (status.status === "completed") {
    return { ...base, exitCode: 0, summary: firstLine(swarmDeliverableText(status)) };
  }
  return {
    ...base,
    exitCode: 1,
    errorCode: `agrenting_swarm_${status.status}`,
    errorMessage: `Agrenting team ${status.swarm_id} ended with status ${status.status}${status.failure_code ? ` (${status.failure_code})` : ""}.`,
  };
}


export function swarmSession(state: SwarmRunState): Record<string, unknown> {
  return {
    mode: "swarm",
    ...(state.swarmId ? { swarmId: state.swarmId } : {}),
    ...(state.pendingCreate ? { pendingCreate: state.pendingCreate } : {}),
    recoveryRequired: true,
    agrentingUrl: state.recoveryUrl,
    credentialFingerprint: state.recoveryFingerprint,
  };
}

export function swarmReconciliation(
  sessionParams: Record<string, unknown>,
  message: string
): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "agrenting_hiring_reconciliation_required",
    errorMessage: message,
    provider: "agrenting",
    biller: "agrenting",
    sessionParams,
    sessionDisplayId: nonEmpty(sessionParams.swarmId) ?? nonEmpty(sessionParams.hiringId),
  };
}

export function swarmRejected(errorMessage: string, rejection: SwarmRejection): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "agrenting_swarm_rejected",
    errorMessage,
    provider: "agrenting",
    biller: "agrenting",
    sessionParams: { mode: "swarm", recoveryRequired: false },
    resultJson: { rejected: true, ...rejection },
  };
}

export function isAdapterResult(
  value: SwarmStatus | AdapterExecutionResult
): value is AdapterExecutionResult {
  return "exitCode" in value;
}

/** POST /api/v1/swarms and apply the definitive / conflict / ambiguous rules to state.pendingCreate. */
export async function createSwarmOrFail(
  client: AgrentingClient,
  state: SwarmRunState,
  body: SwarmCreateBody
): Promise<SwarmStatus | AdapterExecutionResult> {
  try {
    const created = await client.createSwarm(body);
    const swarmId = nonEmpty(created?.swarm_id);
    if (!swarmId) throw new Error("Agrenting accepted the team request but returned no swarm_id.");
    state.swarmId = swarmId;
    state.pendingCreate = null;
    return created;
  } catch (error) {
    const failure = classifySwarmCreateError(error);
    if (failure.kind === "definitive") {
      state.pendingCreate = null;
      const label = failure.code ? `HTTP ${failure.httpStatus} ${failure.code}` : `HTTP ${failure.httpStatus}`;
      return swarmRejected(`Agrenting refused the team (${label}): ${failure.message}`, {
        httpStatus: failure.httpStatus,
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
    }
    if (failure.kind === "conflict") {
      state.pendingCreate = {
        kind: "swarm",
        idempotencyKey: body.client_idempotency_key,
        createdAt: state.pendingCreate?.createdAt ?? null,
        manualOnly: true,
      };
      return swarmReconciliation(
        swarmSession(state),
        `Agrenting already holds a different team request under idempotency key ${body.client_idempotency_key}; no team was created. Check your teams on Agrenting, then clear this agent's session.`
      );
    }
    const replayable = state.pendingCreate !== null && swarmRequestFromRecovery(state.pendingCreate) !== null;
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: replayable ? "agrenting_swarm_request_failed" : "agrenting_hiring_reconciliation_required",
      errorFamily: replayable ? "transient_upstream" : null,
      errorMessage: failure.message,
      provider: "agrenting",
      biller: "agrenting",
      sessionParams: swarmSession(state),
      resultJson: { swarmId: null, status: "unknown", openQuestions: [] },
    };
  }
}

/** Timeout: keep the swarmId for the next run; never cancel (15.3). */
export function swarmDetachResult(
  status: SwarmStatus,
  state: SwarmRunState,
  timeoutSec: number,
  baseUrl: string,
  openQuestions: SwarmQuestion[]
): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: true,
    errorCode: "agrenting_swarm_timeout",
    errorMessage: `Agrenting team ${state.swarmId} is still ${status.status} after ${timeoutSec}s. The adapter detached without cancelling; the next run resumes it.`,
    provider: "agrenting",
    biller: "agrenting",
    sessionParams: swarmSession(state),
    sessionDisplayId: state.swarmId,
    resultJson: swarmResultJson(status, baseUrl, openQuestions),
  };
}


export interface SwarmRun {
  ctx: AdapterExecutionContext;
  client: AgrentingClient;
  config: AgrentingAdapterConfig;
  swarm: SwarmModeConfig;
  state: SwarmRunState;
  prior: Record<string, unknown> | null;
  now: Date;
}

async function safeLog(
  ctx: AdapterExecutionContext,
  stream: "stdout" | "stderr",
  chunk: string
): Promise<void> {
  try {
    await ctx.onLog(stream, chunk);
  } catch {
    // A host logging outage must not discard team recovery state.
  }
}

/** Replay, resume, wake gate, budget and create, in that order (15.2, 15.4, 15.5). */
export async function startSwarm(run: SwarmRun): Promise<SwarmStatus | AdapterExecutionResult> {
  const { ctx, client, config, swarm, state, prior, now } = run;
  if (state.pendingCreate) {
    const key = nonEmpty(state.pendingCreate.idempotencyKey) ?? "unknown";
    const request = swarmRequestFromRecovery(state.pendingCreate);
    if (!request) {
      return swarmReconciliation(swarmSession(state),
        `Manual reconciliation required for team idempotency key ${key}; no replacement was created.`);
    }
    if (!swarmReplayAllowed(state.pendingCreate.createdAt, now)) {
      return swarmReconciliation(swarmSession(state),
        `The team request with idempotency key ${key} was first sent more than 30 minutes ago and will not be replayed. Check your teams on Agrenting, then clear this agent's session.`);
    }
    await ctx.onLog("stdout", `[agrenting] Replaying team request ${key} first sent at ${String(state.pendingCreate.createdAt)}\n`);
    return createSwarmOrFail(client, state, request);
  }

  if (state.swarmId) {
    const status = await client.getSwarm(state.swarmId);
    await ctx.onLog("stdout", `[agrenting] Resuming team ${state.swarmId} with status ${status.status}\n`);
    return status;
  }

  const reason = swarmWakeReasonFrom(ctx.context);
  if (!swarmCreateAllowed(reason, swarm.swarmCreateWakeReasons)) {
    const summary = `No Agrenting team was created: wake reason ${reason ?? "(none)"} is not in swarmCreateWakeReasons.`;
    await safeLog(ctx, "stdout", `[agrenting] ${summary}\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "agrenting",
      biller: "agrenting",
      summary,
      resultJson: { swarmCreated: false, wakeReason: reason },
      ...(prior ? { sessionParams: prior, sessionDisplayId: nonEmpty(prior.swarmId) ?? nonEmpty(prior.hiringId) } : {}),
    };
  }

  const base = {
    task_description: taskDescriptionFrom(ctx),
    task_input: swarmTaskInputFrom(ctx),
    delivery_mode: "output" as const,
    client_idempotency_key: ctx.runId,
  };
  let body: SwarmCreateBody;
  let totalCents: number;
  let description: string;
  if (swarm.roster) {
    const built = swarmRosterBody(swarm.roster);
    totalCents = built.totalCents;
    body = { ...base, total_price: centsToPrice(totalCents), lead: built.lead, members: built.members };
    description = `a team of 1 lead and ${built.members.length} members`;
  } else if (swarm.teamListingId) {
    const listingId = swarm.teamListingId;
    let listing: TeamListing;
    try {
      listing = await client.getTeamListing(listingId);
    } catch (error) {
      const facts = asRecord(error);
      if (facts?.status !== 404) throw error;
      const message = `Team listing ${listingId} was not found for this API key.`;
      return swarmRejected(message, {
        httpStatus: 404, code: typeof facts.code === "string" ? facts.code : null, message,
        details: [{ slot: "team_listing_id", code: "not_found" }],
      });
    }
    const cents = priceToCents(listing.total_price);
    if (cents === null) throw new Error(`Agrenting returned team listing ${listing.id} without a readable total_price.`);
    totalCents = cents;
    body = { ...base, total_price: centsToPrice(cents), team_listing_id: listing.id };
    description = `listed team ${listing.name} (${listing.id})`;
  } else {
    const teamId = swarm.savedTeamId ?? "";
    const team = (await client.listSavedTeams()).find((entry: SavedTeam) => entry.id === teamId);
    if (!team) {
      const message = `Saved team ${teamId} was not found for this API key; no team was created.`;
      return swarmRejected(message, {
        httpStatus: null, code: null, message,
        details: [{ slot: "saved_team_id", code: "not_found" }],
      });
    }
    const cents = priceToCents(team.total_price);
    if (cents === null) throw new Error(`Agrenting returned saved team ${team.id} without a readable total_price.`);
    totalCents = cents;
    body = { ...base, total_price: centsToPrice(cents), saved_team_id: team.id };
    description = `saved team ${team.name} (${team.id})`;
  }

  const total = centsToPrice(totalCents);
  const max = centsToPrice(swarm.maxTotalPriceCents);
  if (totalCents > swarm.maxTotalPriceCents) {
    const message = `Team total ${total} exceeds maxTotalPrice ${max}; no team was created.`;
    return swarmRejected(message, {
      httpStatus: null, code: null, message,
      details: [{ slot: "total_price", code: "max_total_price_exceeded", total_price: total, max_total_price: max }],
    });
  }

  await ctx.onLog("stdout", `[agrenting] Hiring ${description} for ${total} (maxTotalPrice ${max})\n`);
  state.pendingCreate = pendingSwarmCreation(body, config.apiKey, now);
  const created = await createSwarmOrFail(client, state, body);
  if (!isAdapterResult(created)) {
    await ctx.onMeta?.({
      adapterType: type,
      command: "POST /api/v1/swarms",
      context: {
        swarmId: state.swarmId,
        totalPrice: total,
        ...(body.saved_team_id
          ? { savedTeamId: body.saved_team_id }
          : body.team_listing_id
            ? { teamListingId: body.team_listing_id }
            : { memberCount: body.members?.length ?? 0 }),
      },
    });
    await ctx.onLog("stdout", `[agrenting] Team ${state.swarmId} created with status ${created.status}\n`);
  }
  return created;
}


/** One team-mode run: validate, guard, bind recovery, start, poll, then detach or report once. */
export async function executePaperclipSwarm(
  ctx: AdapterExecutionContext,
  now: Date
): Promise<AdapterExecutionResult> {
  const config = configFrom(ctx.config);
  const parsed = swarmConfigFrom(ctx.config);
  if (!config.apiKey) {
    return { exitCode: 1, signal: null, timedOut: false, errorCode: "agrenting_config_invalid",
      errorMessage: "Agrenting requires apiKey." };
  }
  if (!parsed.ok) {
    return { exitCode: 1, signal: null, timedOut: false, errorCode: "agrenting_config_invalid",
      errorMessage: parsed.error };
  }
  const prior = asRecord(ctx.runtime.sessionParams);
  if (prior && hiringRecoveryPending(prior)) {
    return swarmReconciliation(prior,
      'A saved single-agent hiring still needs recovery. Set mode back to "hiring" to finish it before this agent hires a team.');
  }

  const credentialFingerprint = createHash("sha256").update(config.apiKey).digest("hex");
  const savedSwarmId = prior?.recoveryRequired === true ? nonEmpty(prior.swarmId) : null;
  const pendingCreate = prior?.recoveryRequired === true && !savedSwarmId
    ? asRecord(prior.pendingCreate) ?? { kind: "swarm", manualOnly: true } : null;
  const recovering = Boolean(savedSwarmId || pendingCreate);
  const state: SwarmRunState = {
    swarmId: savedSwarmId,
    pendingCreate,
    recoveryUrl: recovering ? nonEmpty(prior?.agrentingUrl) ?? config.agrentingUrl : config.agrentingUrl,
    recoveryFingerprint: recovering
      ? nonEmpty(prior?.credentialFingerprint) ?? credentialFingerprint : credentialFingerprint,
  };
  const openQuestions = new Map<string, SwarmQuestion>();
  const client = new AgrentingClient(config);
  let status: SwarmStatus | undefined;

  try {
    if (recovering && (
      new URL(state.recoveryUrl).href.replace(/\/+$/, "") !== new URL(config.agrentingUrl).href.replace(/\/+$/, "") ||
      state.recoveryFingerprint !== credentialFingerprint)) {
      return swarmReconciliation(swarmSession(state),
        "Restore the original Agrenting URL and credential to reconcile the saved team before creating another.");
    }
    const started = await startSwarm({ ctx, client, config, swarm: parsed.value, state, prior, now });
    if (isAdapterResult(started)) return started;
    status = started;

    const recordQuestions = async (snapshot: SwarmStatus): Promise<void> => {
      for (const question of swarmOpenQuestions(snapshot)) {
        if (openQuestions.has(question.question_id)) continue;
        openQuestions.set(question.question_id, question);
        await ctx.onLog("stderr",
          `[agrenting] Open question ${question.question_id} (${question.alias ?? question.role ?? "team"}): ${question.content}\n`);
      }
    };
    const activeSwarmId = state.swarmId ?? status.swarm_id;
    const timeoutSec = config.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutSec * 1_000;
    let lastStatus = status.status;
    await recordQuestions(status);
    while (!swarmFinal(status) && Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      status = await client.getSwarm(activeSwarmId);
      await recordQuestions(status);
      if (status.status !== lastStatus) {
        lastStatus = status.status;
        await ctx.onLog("stdout", `[agrenting] Team ${activeSwarmId} is ${status.status}\n`);
      }
    }

    const questions = Array.from(openQuestions.values());
    if (!swarmFinal(status)) {
      await safeLog(ctx, "stderr",
        `[agrenting] Team ${activeSwarmId} is still ${status.status} after ${timeoutSec}s; detached without cancelling\n`);
      return swarmDetachResult(status, state, timeoutSec, config.agrentingUrl, questions);
    }
    if (status.status === "completed") await ctx.onLog("stdout", `${swarmDeliverableText(status)}\n`);
    return swarmFinalResult(status, config.agrentingUrl, questions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await safeLog(ctx, "stderr", `[agrenting] ${message}\n`);
    const replayable = state.pendingCreate === null || swarmRequestFromRecovery(state.pendingCreate) !== null;
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: replayable ? "agrenting_swarm_request_failed" : "agrenting_hiring_reconciliation_required",
      errorFamily: replayable && classifySwarmCreateError(error).kind === "ambiguous" ? "transient_upstream" : null,
      errorMessage: message,
      provider: "agrenting",
      biller: "agrenting",
      ...(state.swarmId || state.pendingCreate ? {
        sessionParams: swarmSession(state),
        sessionDisplayId: state.swarmId,
        resultJson: {
          swarmId: state.swarmId,
          status: status?.status ?? "unknown",
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
