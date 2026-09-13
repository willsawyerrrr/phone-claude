import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEADER = "x-twilio-signature";

/**
 * Verifies a Twilio webhook request per Twilio's request validation scheme:
 * HMAC-SHA1, keyed by the account auth token, over the full request URL
 * with each POST parameter's key and value appended in sorted-by-key order
 * (no parameters for a GET request), base64-encoded and compared to the
 * `X-Twilio-Signature` header.
 */
export function verifyTwilioSignature(
  headers: Headers,
  url: string,
  params: Record<string, string>,
  authToken: string,
): boolean {
  const provided = headers.get(SIGNATURE_HEADER);
  if (!provided) return false;

  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
