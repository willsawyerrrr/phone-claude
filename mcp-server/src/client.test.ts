import { describe, expect, it, vi, afterEach } from "vitest";
import type { Config } from "./config.js";
import { pollForAnswer } from "./client.js";

const config: Config = {
  apiUrl: "https://example.com",
  apiSecret: "secret",
  userPhoneNumber: "+10000000000",
  pollIntervalMs: 0,
  maxWaitMs: 200,
};

describe("pollForAnswer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the answer once the call is answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "answered", answer: "Yes" })),
      ),
    );

    await expect(pollForAnswer(config, "call-1")).resolves.toBe("Yes");
  });

  it("throws with the reported error when the call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: "failed", error: "No answer" }),
          ),
      ),
    );

    await expect(pollForAnswer(config, "call-1")).rejects.toThrow("No answer");
  });

  it("times out if the call stays pending past maxWaitMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "pending" }))),
    );

    await expect(pollForAnswer(config, "call-1")).rejects.toThrow(/Timed out/);
  });
});
