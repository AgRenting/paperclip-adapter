import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyWebhookSignature } from "./crypto.js";

async function computeSignature(rawBody: string, secret: string): Promise<string> {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

describe("verifyWebhookSignature", () => {
  it("returns true for a valid HMAC-SHA256 signature", async () => {
    const body = '{"task_id":"123","status":"completed"}';
    const secret = "my-webhook-secret";
    const signature = await computeSignature(body, secret);

    const result = await verifyWebhookSignature(body, signature, secret);
    expect(result).toBe(true);
  });

  it("returns false for an incorrect signature", async () => {
    const body = '{"task_id":"123","status":"completed"}';
    const secret = "my-webhook-secret";
    const wrongSignature = "d3Jvbmdfc2lnbmF0dXJl";

    const result = await verifyWebhookSignature(body, wrongSignature, secret);
    expect(result).toBe(false);
  });

  it("returns false when secret is wrong but signature has correct length", async () => {
    const body = '{"task_id":"123","status":"completed"}';
    const correctSecret = "correct-secret";
    const wrongSecret = "wrong-secret";
    const signature = await computeSignature(body, correctSecret);

    const result = await verifyWebhookSignature(body, signature, wrongSecret);
    expect(result).toBe(false);
  });

  it("returns false for empty signature", async () => {
    const body = '{"task_id":"123"}';
    const result = await verifyWebhookSignature(body, "", "secret");
    expect(result).toBe(false);
  });

  it("returns false when body is tampered", async () => {
    const originalBody = '{"task_id":"123","status":"completed"}';
    const secret = "secret";
    const signature = await computeSignature(originalBody, secret);

    const tamperedBody = '{"task_id":"123","status":"failed"}';
    const result = await verifyWebhookSignature(tamperedBody, signature, secret);
    expect(result).toBe(false);
  });

  it("handles unicode body content correctly", async () => {
    const body = '{"message":"Héllo Wörld 🌍"}';
    const secret = "secret";
    const signature = await computeSignature(body, secret);

    const result = await verifyWebhookSignature(body, signature, secret);
    expect(result).toBe(true);
  });
});
