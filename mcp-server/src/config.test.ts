import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
  ARI_USERNAME: "phone-claude",
  ARI_PASSWORD: "secret",
};

describe("loadConfig", () => {
  it("applies default poll and timeout values", () => {
    const config = loadConfig(baseEnv);
    expect(config.pollIntervalMs).toBe(3_000);
    expect(config.maxWaitMs).toBe(10 * 60 * 1_000);
  });

  it("defaults to the local Compose stack's ports and dialplan", () => {
    const config = loadConfig(baseEnv);
    expect(config).toMatchObject({
      pipelineUrl: "http://localhost:8080",
      ariUrl: "http://localhost:8088",
      sipEndpoint: "phone",
      dialplanContext: "ask-by-phone",
      dialplanExtension: "700",
    });
  });

  it("strips trailing slashes from the service URLs", () => {
    const config = loadConfig({
      ...baseEnv,
      PIPELINE_URL: "http://pipeline:8080/",
      ARI_URL: "http://asterisk:8088//",
    });
    expect(config.pipelineUrl).toBe("http://pipeline:8080");
    expect(config.ariUrl).toBe("http://asterisk:8088");
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

  it("honours overrides for the soft-phone endpoint and dialplan", () => {
    const config = loadConfig({
      ...baseEnv,
      SIP_ENDPOINT: "will-iphone",
      DIALPLAN_CONTEXT: "custom",
      DIALPLAN_EXTENSION: "800",
    });
    expect(config).toMatchObject({
      sipEndpoint: "will-iphone",
      dialplanContext: "custom",
      dialplanExtension: "800",
    });
  });

  it("throws when a required env var is missing", () => {
    expect(() => loadConfig({})).toThrow(/ARI_USERNAME/);
    expect(() => loadConfig({ ARI_USERNAME: "u" })).toThrow(/ARI_PASSWORD/);
  });
});
