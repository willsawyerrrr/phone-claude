import { createPublicKey, verify } from "node:crypto";

const SIGNATURE_HEADER = "telnyx-signature-ed25519";
const TIMESTAMP_HEADER = "telnyx-timestamp";
const TIMESTAMP_TOLERANCE_SECONDS = 300;

// DER SubjectPublicKeyInfo prefix that wraps a raw 32-byte Ed25519 public
// key (RFC 8410) — what Telnyx's public key, a bare base64 string, decodes
// to — into the form node:crypto's `verify` requires.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verifies a Telnyx webhook request per Telnyx's request validation scheme:
 * Ed25519, keyed by the account's public key (from the Telnyx portal), over
 * `${timestamp}|${rawBody}` — the exact bytes Telnyx sent, never a
 * re-serialized body — compared to the base64-encoded
 * `Telnyx-Signature-Ed25519` header. Rejects a timestamp more than 5 minutes
 * from now, guarding against replay.
 */
export function verifyTelnyxSignature(
  headers: Headers,
  rawBody: string,
  publicKey: string,
): boolean {
  const signature = headers.get(SIGNATURE_HEADER);
  const timestamp = headers.get(TIMESTAMP_HEADER);
  if (!signature || !timestamp) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SECONDS) return false;

  try {
    const key = createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(publicKey, "base64"),
      ]),
      format: "der",
      type: "spki",
    });

    return verify(
      null,
      Buffer.from(`${timestamp}|${rawBody}`, "utf-8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
