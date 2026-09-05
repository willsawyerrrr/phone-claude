import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Vapi server-message webhook signature.
 *
 * Vapi's default HMAC credential signs `${timestamp}.${rawBody}` with
 * HMAC-SHA256 and sends the hex digest in `x-vapi-signature`, alongside the
 * timestamp in `x-vapi-timestamp`. Both the header names and payload format
 * are configurable per-credential in the Vapi dashboard (Server URL Secret /
 * Custom Credential settings) — confirm these match what's configured there,
 * see https://docs.vapi.ai/server-url/server-authentication.
 */
export function verifyVapiSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): boolean {
  const signature = headers.get("x-vapi-signature");
  const timestamp = headers.get("x-vapi-timestamp");
  if (!signature || !timestamp) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}
