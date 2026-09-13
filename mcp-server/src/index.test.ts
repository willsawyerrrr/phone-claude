import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";

const registerTool = vi.fn();
const connect = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn(function McpServer() {
    return { registerTool, connect };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function StdioServerTransport() {
    return {};
  }),
}));

const config: Config = {
  apiUrl: "https://example.com",
  apiSecret: "secret",
  userPhoneNumber: "+10000000000",
  pollIntervalMs: 0,
  maxWaitMs: 1_000,
};

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(() => config),
}));

vi.mock("./client.js", () => ({
  startCall: vi.fn(),
  pollForAnswer: vi.fn(),
  cancelCall: vi.fn(),
}));

const { startCall, pollForAnswer, cancelCall } = await import("./client.js");
await import("./index.js");

/** The `ask_by_phone` handler `index.ts` passed to `registerTool`. */
const handler = registerTool.mock.calls[0]?.[2] as (args: {
  question: string;
  context?: string;
}) => Promise<unknown>;

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("shutdown on SIGINT/SIGTERM", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    vi.mocked(cancelCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(startCall).mockReset();
    vi.mocked(pollForAnswer).mockReset();
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("exits without cancelling when no call is in flight", async () => {
    process.emit("SIGINT");
    await flushAsync();

    expect(cancelCall).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("cancels the in-flight call on SIGINT", async () => {
    vi.mocked(startCall).mockResolvedValue("call-1");
    vi.mocked(pollForAnswer).mockReturnValue(new Promise(() => {})); // never resolves

    void handler({ question: "Deploy?" });
    await flushAsync();

    process.emit("SIGINT");
    await flushAsync();

    expect(cancelCall).toHaveBeenCalledWith(config, "call-1");
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("cancels the in-flight call on SIGTERM", async () => {
    vi.mocked(startCall).mockResolvedValue("call-2");
    vi.mocked(pollForAnswer).mockReturnValue(new Promise(() => {})); // never resolves

    void handler({ question: "Deploy?" });
    await flushAsync();

    process.emit("SIGTERM");
    await flushAsync();

    expect(cancelCall).toHaveBeenCalledWith(config, "call-2");
    expect(exitSpy).toHaveBeenCalledWith(143);
  });
});
