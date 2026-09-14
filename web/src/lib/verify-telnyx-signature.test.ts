import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTelnyxSignature } from "./verify-telnyx-signature";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = rawPublicKeyBase64(publicKey);

function rawPublicKeyBase64(key: typeof publicKey): string {
  // Strip the fixed 12-byte SPKI DER prefix to get the raw 32-byte key
  // Telnyx publishes.
  return key
    .export({ type: "spki", format: "der" })
    .subarray(12)
    .toString("base64");
}

function sign(timestamp: string, body: string): string {
  return signEd25519(
    null,
    Buffer.from(`${timestamp}|${body}`, "utf-8"),
    privateKey,
  ).toString("base64");
}

describe("verifyTelnyxSignature", () => {
  it("rejects missing headers", () => {
    const headers = new Headers();
    expect(verifyTelnyxSignature(headers, "{}", PUBLIC_KEY)).toBe(false);
  });

  it("accepts a valid signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"data":{"event_type":"call.answered"}}';
    const headers = new Headers({
      "telnyx-signature-ed25519": sign(timestamp, body),
      "telnyx-timestamp": timestamp,
    });
    expect(verifyTelnyxSignature(headers, body, PUBLIC_KEY)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"data":{"event_type":"call.answered"}}';
    const headers = new Headers({
      "telnyx-signature-ed25519": sign(timestamp, body),
      "telnyx-timestamp": timestamp,
    });
    expect(
      verifyTelnyxSignature(
        headers,
        '{"data":{"event_type":"call.hangup"}}',
        PUBLIC_KEY,
      ),
    ).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = "{}";
    const headers = new Headers({
      "telnyx-signature-ed25519": sign(timestamp, body),
      "telnyx-timestamp": timestamp,
    });
    const other = rawPublicKeyBase64(generateKeyPairSync("ed25519").publicKey);
    expect(verifyTelnyxSignature(headers, body, other)).toBe(false);
  });

  it("rejects a stale timestamp", () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 301);
    const body = "{}";
    const headers = new Headers({
      "telnyx-signature-ed25519": sign(timestamp, body),
      "telnyx-timestamp": timestamp,
    });
    expect(verifyTelnyxSignature(headers, body, PUBLIC_KEY)).toBe(false);
  });
});
