/**
 * Shared cryptographic utilities for the Agrenting adapter.
 */

/**
 * Verify an HMAC-SHA256 signature against a raw request body.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const crypto = await import("crypto");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.byteLength !== expectedBuf.byteLength) {
    return false;
  }
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}
