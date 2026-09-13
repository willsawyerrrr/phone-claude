import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTwilioSignature } from "./verify-twilio-signature";

const AUTH_TOKEN = "test-auth-token";
const URL = "https://example.com/api/webhooks/twilio/call-1";

function sign(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
}

describe("verifyTwilioSignature", () => {
  it("rejects a missing header", () => {
    const headers = new Headers();
    expect(verifyTwilioSignature(headers, URL, {}, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a mismatched signature", () => {
    const headers = new Headers({ "x-twilio-signature": "wrong" });
    expect(verifyTwilioSignature(headers, URL, {}, AUTH_TOKEN)).toBe(false);
  });

  it("accepts a valid signature with no params (GET request)", () => {
    const headers = new Headers({
      "x-twilio-signature": sign(URL, {}),
    });
    expect(verifyTwilioSignature(headers, URL, {}, AUTH_TOKEN)).toBe(true);
  });

  it("accepts a valid signature over sorted POST params", () => {
    const params = { SpeechResult: "Yes", Confidence: "0.9" };
    const headers = new Headers({
      "x-twilio-signature": sign(URL, params),
    });
    expect(verifyTwilioSignature(headers, URL, params, AUTH_TOKEN)).toBe(true);
  });

  it("rejects when a param value has been tampered with", () => {
    const params = { SpeechResult: "Yes" };
    const headers = new Headers({
      "x-twilio-signature": sign(URL, params),
    });
    const tampered = { SpeechResult: "No" };
    expect(verifyTwilioSignature(headers, URL, tampered, AUTH_TOKEN)).toBe(
      false,
    );
  });

  it("rejects when the URL doesn't match what was signed", () => {
    const headers = new Headers({
      "x-twilio-signature": sign(URL, {}),
    });
    expect(
      verifyTwilioSignature(
        headers,
        "https://example.com/api/webhooks/twilio/call-2",
        {},
        AUTH_TOKEN,
      ),
    ).toBe(false);
  });
});
