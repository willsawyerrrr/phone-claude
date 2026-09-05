import { timingSafeEqual } from "node:crypto";

const SECRET_HEADER = "x-vapi-secret";

/**
 * Verifies a Vapi server-message webhook request. The assistant's webhook
 * credential is configured with a Bearer authentication plan whose token is
 * sent verbatim in the `x-vapi-secret` header (no "Bearer " prefix), see
 * `web/src/lib/providers/vapi.ts` and the README.
 */
export function verifyVapiSecret(headers: Headers, secret: string): boolean {
  const provided = headers.get(SECRET_HEADER);
  if (!provided) return false;

  const providedBuf = Buffer.from(provided);
  const secretBuf = Buffer.from(secret);
  if (providedBuf.length !== secretBuf.length) return false;

  return timingSafeEqual(providedBuf, secretBuf);
}
