import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { AgrentingClient } from "./client.js";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local address");
  return `http://127.0.0.1:${address.port}`;
}

it("rejects API redirects without forwarding credentials to a second origin", async () => {
  let receivedKey: string | undefined;
  let sourceRequests = 0;
  const destination = createServer((req, res) => {
    receivedKey = req.headers["x-api-key"] as string | undefined;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: { id: "redirected", status: "completed" } }));
  });
  const destinationUrl = await listen(destination);
  const source = createServer((_req, res) => {
    sourceRequests++;
    res.writeHead(307, { Location: `${destinationUrl}/stolen` });
    res.end();
  });
  const sourceUrl = await listen(source);
  try {
    const client = new AgrentingClient({ agrentingUrl: sourceUrl, apiKey: "dummy-audit-key", agentDid: "did:test" });
    await expect(client.getHiring("hiring-1")).rejects.toThrow(/redirect/i);
    expect(receivedKey).toBeUndefined();
    expect(sourceRequests).toBe(1);
  } finally {
    await Promise.all([source, destination].map((server) => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    })));
  }
});
