import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
  PHONE_CLAUDE_API_URL: "https://example.com/",
  PHONE_CLAUDE_API_SECRET: "secret",
  USER_PHONE_NUMBER: "+10000000000",
};

describe("loadConfig", () => {
  it("applies default poll and timeout values", () => {
    const config = loadConfig(baseEnv);
    expect(config.pollIntervalMs).toBe(3_000);
    expect(config.maxWaitMs).toBe(10 * 60 * 1_000);
  });

  it("strips a trailing slash from the API URL", () => {
    const config = loadConfig(baseEnv);
    expect(config.apiUrl).toBe("https://example.com");
  });

  it("honours overrides for poll interval and max wait", () => {
    const config = loadConfig({
      ...baseEnv,
      POLL_INTERVAL_MS: "1000",
      MAX_WAIT_MS: "5000",
    });
    expect(config.pollIntervalMs).toBe(1_000);
    expect(config.maxWaitMs).toBe(5_000);
  });

  it("throws when a required env var is missing", () => {
    expect(() => loadConfig({})).toThrow(/PHONE_CLAUDE_API_URL/);
  });
});
