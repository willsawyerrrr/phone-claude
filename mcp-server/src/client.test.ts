import { describe, expect, it, vi, afterEach } from "vitest";
import type { Config } from "./config.js";
import { cancelCall, pollForAnswer } from "./client.js";

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

  it("cancels the call before reporting a timeout", async () => {
    const fetchMock = vi.fn(
      async (url: string, _init?: RequestInit) =>
        new Response(
          url.endsWith("/cancel")
            ? "{}"
            : JSON.stringify({ status: "pending" }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollForAnswer(config, "call-1")).rejects.toThrow(/Timed out/);

    const cancelRequest = fetchMock.mock.calls.find(([url]) =>
      (url as string).endsWith("/api/calls/call-1/cancel"),
    );
    expect(cancelRequest).toBeDefined();
    expect(cancelRequest?.[1]).toMatchObject({ method: "POST" });
  });
});

describe("cancelCall", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the cancel endpoint with the bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await cancelCall(config, "call-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/api/calls/call-1/cancel",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
    );
  });

  it("swallows a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(cancelCall(config, "call-1")).resolves.toBeUndefined();
  });
});
