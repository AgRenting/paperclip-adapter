import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { autoSelectAgent, execute, startWebhookListener, stopWebhookListener } from "./adapter.js";

const client = vi.hoisted(() => ({
  getAgentProfile: vi.fn(), createTask: vi.fn(), getTask: vi.fn(),
  listCapabilities: vi.fn(), listAgentsByCapability: vi.fn(), hireAgent: vi.fn(),
}));
vi.mock("./client.js", () => ({ AgrentingClient: vi.fn().mockImplementation(function () { return client; }) }));
vi.mock("./balance-monitor.js", () => ({ canSubmitTask: vi.fn().mockResolvedValue({ ok: true }) }));
const config = { agrentingUrl: "https://unused.example", apiKey: "dummy-key", agentDid: "did:agent", timeoutSec: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  client.getAgentProfile.mockResolvedValue({ id: "agent" });
  client.createTask.mockResolvedValue({ id: "task-1", status: "pending" });
  client.getTask.mockResolvedValue({ id: "task-1", status: "in_progress" });
});
afterEach(async () => {
  await stopWebhookListener();
  vi.unstubAllEnvs();
});

async function availablePort(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return String(address.port);
}

it("refuses to expose a webhook listener without a signing secret", async () => {
  vi.stubEnv("PAPERCLIP_WEBHOOK_PORT", await availablePort());
  await expect(startWebhookListener(config)).rejects.toThrow(/secret/i);
});

it("falls back to polling when only a callback URL is configured", async () => {
  client.getTask.mockResolvedValue({ id: "task-1", status: "completed", output: "Canonical output" });
  const result = await execute({ ...config, webhookCallbackUrl: "https://callback.example" }, { input: "hello", capability: "review" });
  expect(result).toMatchObject({ success: true, output: "Canonical output" });
});

it("authenticates callbacks and resolves only canonical terminal output", async () => {
  vi.stubEnv("PAPERCLIP_WEBHOOK_PORT", await availablePort());
  const secured = { ...config, webhookSecret: "dummy-signing-secret" };
  const url = await startWebhookListener(secured);
  let settled = false;
  const running = execute(secured, { input: "hello", capability: "review" }).then((result) => { settled = true; return result; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const body = JSON.stringify({ task_id: "task-1", status: "completed", output: "Forged output" });
  const unsigned = await fetch(url, { method: "POST", body });
  expect(unsigned.status).toBe(401);
  expect(client.getTask).not.toHaveBeenCalled();
  const signature = createHmac("sha256", secured.webhookSecret).update(body).digest("base64");
  const headers = { "x-webhook-signature": signature };
  const premature = await fetch(url, { method: "POST", body, headers });
  expect(premature.ok).toBe(true);
  expect(settled).toBe(false);
  client.getTask.mockResolvedValue({ id: "task-1", status: "completed", output: "Canonical output" });
  await fetch(url, { method: "POST", body, headers });
  await expect(running).resolves.toMatchObject({ success: true, output: "Canonical output" });
});

it("polls canonical status after the webhook grace period when callbacks never arrive", async () => {
  vi.stubEnv("PAPERCLIP_WEBHOOK_PORT", await availablePort());
  client.getTask.mockResolvedValue({ id: "task-1", status: "completed", output: "Polled result" });
  const result = await execute({ ...config, webhookSecret: "dummy-signing-secret" }, { input: "hello", capability: "review" });
  expect(result).toMatchObject({ success: true, output: "Polled result" });
});

it("keeps accepting callbacks after a fallback status read fails", async () => {
  vi.stubEnv("PAPERCLIP_WEBHOOK_PORT", await availablePort());
  const secured = { ...config, webhookSecret: "dummy-signing-secret" };
  const url = await startWebhookListener(secured);
  let sawPoll: () => void = () => {};
  const polled = new Promise<void>((resolve) => { sawPoll = resolve; });
  client.getTask.mockImplementationOnce(async () => { sawPoll(); throw new Error("status temporarily unavailable"); });
  let settled = false;
  const running = execute(secured, { input: "hello", capability: "review" }).then(
    (result) => { settled = true; return result; },
    (error) => { settled = true; return { success: false, error: String(error) }; }
  );
  await polled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  client.getTask.mockResolvedValue({ id: "task-1", status: "completed", output: "Recovered callback result" });
  const body = JSON.stringify({ task_id: "task-1", status: "completed" });
  const signature = createHmac("sha256", secured.webhookSecret).update(body).digest("base64");
  await fetch(url, { method: "POST", body, headers: { "x-webhook-signature": signature } });
  await expect(running).resolves.toMatchObject({ success: true, output: "Recovered callback result" });
});

it.each(["reputation_score", "base_price"] as const)("prioritizes availability before %s", async (sortBy) => {
  client.listCapabilities.mockResolvedValue([{ name: "review" }]);
  client.listAgentsByCapability.mockResolvedValue([
    { did: "did:busy", availability_status: "busy", reputation_score: "99", base_price: "1.00" },
    { did: "did:available", availability_status: "available", reputation_score: "10", base_price: "5.00" },
  ]);
  client.hireAgent.mockImplementation(async (did: string) => ({ hiring: { id: "hiring", agent_did: did } }));
  const result = await autoSelectAgent(config, { capability: "review", taskDescription: "review", sortBy });
  expect(result.selectedAgent.did).toBe("did:available");
  expect(result.hiring.agent_did).toBe("did:available");
});

it("allows explicit reputation priority when availability preference is disabled", async () => {
  client.listCapabilities.mockResolvedValue([{ name: "review" }]);
  client.listAgentsByCapability.mockResolvedValue([
    { did: "did:available", availability_status: "available", reputation_score: "10", base_price: "5.00" },
    { did: "did:busy", availability_status: "busy", reputation_score: "99", base_price: "1.00" },
  ]);
  client.hireAgent.mockImplementation(async (did: string) => ({ hiring: { id: "hiring", agent_did: did } }));
  const result = await autoSelectAgent(config, { capability: "review", taskDescription: "review", preferAvailable: false });
  expect(result.selectedAgent.did).toBe("did:busy");
});
