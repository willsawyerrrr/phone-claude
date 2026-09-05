import { describe, expect, it } from "vitest";
import { verifyVapiSecret } from "./verify-vapi-secret";

describe("verifyVapiSecret", () => {
  it("rejects a missing header", () => {
    const headers = new Headers();
    expect(verifyVapiSecret(headers, "secret")).toBe(false);
  });

  it("rejects a mismatched secret", () => {
    const headers = new Headers({ "x-vapi-secret": "wrong" });
    expect(verifyVapiSecret(headers, "secret")).toBe(false);
  });

  it("accepts a matching secret", () => {
    const headers = new Headers({ "x-vapi-secret": "secret" });
    expect(verifyVapiSecret(headers, "secret")).toBe(true);
  });
});
