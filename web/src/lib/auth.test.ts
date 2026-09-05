import { describe, expect, it, afterEach, vi } from "vitest";
import { isAuthorized } from "./auth";

describe("isAuthorized", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects when API_SECRET is unset", () => {
    vi.stubEnv("API_SECRET", "");
    const request = new Request("http://localhost", {
      headers: { authorization: "Bearer anything" },
    });
    expect(isAuthorized(request)).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    vi.stubEnv("API_SECRET", "secret");
    const request = new Request("http://localhost");
    expect(isAuthorized(request)).toBe(false);
  });

  it("rejects a mismatched token", () => {
    vi.stubEnv("API_SECRET", "secret");
    const request = new Request("http://localhost", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(isAuthorized(request)).toBe(false);
  });

  it("accepts a matching bearer token", () => {
    vi.stubEnv("API_SECRET", "secret");
    const request = new Request("http://localhost", {
      headers: { authorization: "Bearer secret" },
    });
    expect(isAuthorized(request)).toBe(true);
  });
});
