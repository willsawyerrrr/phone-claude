import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { ConfigResult } from "./server.js";
import { registerAskByPhoneTool, registerShutdownHandlers } from "./server.js";

vi.mock("./client.js", () => ({
  startCall: vi.fn(),
  pollForAnswer: vi.fn(),
  cancelCall: vi.fn(),
}));

const { startCall, pollForAnswer, cancelCall } = await import("./client.js");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const config: Config = {
  pipelineUrl: "http://localhost:8080",
  ariUrl: "http://localhost:8088",
  ariUsername: "phone-claude",
  ariPassword: "secret",
  sipEndpoint: "phone",
  dialplanContext: "ask-by-phone",
  dialplanExtension: "700",
  pollIntervalMs: 0,
  maxWaitMs: 1_000,
  pushWaitMs: 1_000,
  ringTimeoutS: 60,
};
const configResult: ConfigResult = { config };

function fakeServer(): { registerTool: ReturnType<typeof vi.fn> } {
  return { registerTool: vi.fn() };
}

type Handler = (args: {
  question: string;
  context?: string;
}) => Promise<unknown>;

function registerHandler(result: ConfigResult): {
  server: ReturnType<typeof fakeServer>;
  handler: Handler;
  activeCalls: Set<string>;
} {
  const server = fakeServer();
  const activeCalls = new Set<string>();
  registerAskByPhoneTool(server as unknown as McpServer, result, activeCalls);
  const handler = server.registerTool.mock.calls[0]?.[2] as Handler;
  return { server, handler, activeCalls };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registerAskByPhoneTool", () => {
  it("returns the answer", async () => {
    vi.mocked(startCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(pollForAnswer).mockReset().mockResolvedValue("Yes");
    const { handler } = registerHandler(configResult);

    await expect(handler({ question: "Deploy?" })).resolves.toEqual({
      content: [{ type: "text", text: "Yes" }],
    });
  });

  it.each([
    ["starting the call", () => vi.mocked(startCall)],
    ["waiting for the answer", () => vi.mocked(pollForAnswer)],
  ])("falls back to chat when %s fails", async (_name, failing) => {
    vi.mocked(startCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(pollForAnswer).mockReset().mockResolvedValue("Yes");
    failing().mockRejectedValue(new Error("fetch failed"));
    const { handler } = registerHandler(configResult);

    await expect(handler({ question: "Deploy?" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "Could not get a phone answer (fetch failed). Ask the user in chat instead.",
        },
      ],
      isError: true,
    });
  });

  it("tracks the call ID in activeCalls only while it's in flight", async () => {
    vi.mocked(startCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(pollForAnswer).mockReset().mockResolvedValue("Yes");
    const { handler, activeCalls } = registerHandler(configResult);

    // The handler adds its call ID synchronously, before its first `await`,
    // so it's already tracked the instant `handler(...)` is called — no need
    // to flush microtasks first (and an instantly-resolving `pollForAnswer`
    // would otherwise have already deleted it again by the time we checked).
    const result = handler({ question: "Deploy?" });
    expect(activeCalls.size).toBe(1);

    await result;
    expect(activeCalls.size).toBe(0);
  });

  it("reports an invalid configuration through the chat fallback", async () => {
    const { handler } = registerHandler({
      error: new Error("Missing required env var: ARI_USERNAME"),
    });

    await expect(handler({ question: "Deploy?" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            "Missing required env var: ARI_USERNAME",
          ),
        },
      ],
      isError: true,
    });
    expect(startCall).not.toHaveBeenCalled();
  });
});

describe("registerShutdownHandlers", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    vi.mocked(cancelCall).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    // Each test registers its own SIGINT/SIGTERM handlers via
    // `registerShutdownHandlers`; clear them so they don't pile up (and fire
    // against a stale `activeCalls`/`configResult`) in later tests.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("exits without cancelling when no call is in flight", async () => {
    registerShutdownHandlers(configResult, new Set());

    process.emit("SIGINT");
    await flushAsync();

    expect(cancelCall).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("cancels every in-flight call on SIGINT", async () => {
    const activeCalls = new Set(["one", "two"]);
    registerShutdownHandlers(configResult, activeCalls);

    process.emit("SIGINT");
    await flushAsync();

    expect(cancelCall).toHaveBeenCalledWith(config, "one");
    expect(cancelCall).toHaveBeenCalledWith(config, "two");
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("cancels every in-flight call on SIGTERM", async () => {
    const activeCalls = new Set(["one"]);
    registerShutdownHandlers(configResult, activeCalls);

    process.emit("SIGTERM");
    await flushAsync();

    expect(cancelCall).toHaveBeenCalledWith(config, "one");
    expect(exitSpy).toHaveBeenCalledWith(143);
  });

  it("exits without cancelling when the configuration failed to load", async () => {
    registerShutdownHandlers(
      { error: new Error("Missing required env var: ARI_USERNAME") },
      new Set(["one"]),
    );

    process.emit("SIGINT");
    await flushAsync();

    expect(cancelCall).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("tracks a call's UUID from registerAskByPhoneTool through to cancellation", async () => {
    vi.mocked(startCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(pollForAnswer)
      .mockReset()
      .mockReturnValue(new Promise(() => {})); // never resolves
    const { handler, activeCalls } = registerHandler(configResult);
    registerShutdownHandlers(configResult, activeCalls);

    void handler({ question: "Deploy?" });
    await flushAsync();
    const callId = vi.mocked(startCall).mock.calls[0]![1];

    process.emit("SIGINT");
    await flushAsync();

    expect(callId).toMatch(UUID_PATTERN);
    expect(cancelCall).toHaveBeenCalledWith(config, callId);
  });
});
