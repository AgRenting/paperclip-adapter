import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { executePaperclip } from "./paperclip.js";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local address");
  return `http://127.0.0.1:${address.port}`;
}

function context(url: string, runId: string): AdapterExecutionContext {
  return {
    runId,
    agent: { id: "paperclip-agent", companyId: "company", name: "Worker", adapterType: "agrenting", adapterConfig: {} },
    config: { agrentingUrl: url, apiKey: "dummy-recovery-key", agentDid: "did:agrenting:reviewer", pollIntervalMs: 1 },
    context: { taskDescription: "Review this public example", price: "7.50" },
    runtime: { sessionId: null, sessionDisplayId: null, sessionParams: null, taskKey: "issue-1" },
    onLog: async () => {},
  };
}

it("recovers a lost accepted POST using the original request and key on a different host run", async () => {
  let loseResponse = true;
  const requests: Array<{ body: Record<string, unknown>; key: string | undefined; path: string }> = [];
  const hirings = new Map<string, string>();
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify({ data: { id: "agent", did: "did:agrenting:reviewer", capabilities: ["review"], base_price: "7.50" } }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    const key = req.headers["x-idempotency-key"] as string | undefined;
    requests.push({ body, key, path: req.url ?? "" });
    if (!hirings.has(String(key))) hirings.set(String(key), `hiring-${hirings.size + 1}`);
    if (loseResponse) {
      // Agrenting accepted the request but its response did not reach the client.
      res.writeHead(503, { "Retry-After": "0" });
      res.end(JSON.stringify({ error: "response unavailable after acceptance" }));
      return;
    }
    res.end(JSON.stringify({ data: { hiring: { id: hirings.get(String(key)), status: "completed", price: "7.50", task_output: "Original result" } } }));
  });
  const url = await listen(server);
  try {
    const original = context(url, "original-run");
    const failed = await executePaperclip(original);
    expect(failed).toMatchObject({ exitCode: 1, sessionParams: { recoveryRequired: true, pendingCreate: { idempotencyKey: "original-run" } } });
    expect(JSON.stringify(failed.sessionParams)).not.toContain("dummy-recovery-key");
    loseResponse = false;
    const followup = context(url, "retry-run");
    followup.config.agentDid = "did:agrenting:different";
    followup.context = { taskDescription: "Changed task", price: "99.00" };
    followup.runtime.sessionParams = failed.sessionParams ?? null;
    const recovered = await executePaperclip(followup);
    expect(recovered).toMatchObject({ exitCode: 0, summary: "Original result", sessionDisplayId: "hiring-1" });
    expect(hirings.size).toBe(1);
    expect(requests.at(-1)).toEqual(requests[0]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
