import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(() => config),
}));

const { loadConfig } = await import("./config.js");

vi.mock("./client.js", () => ({
  startCall: vi.fn(),
  pollForAnswer: vi.fn(),
  cancelCall: vi.fn(),
}));

const { startCall, cancelCall } = await import("./client.js");

// `index.ts` wires everything up as a side effect of being imported (once —
// ES modules are cached, matching how it only ever runs once as a process
// entrypoint); `server.test.ts` covers the tool/shutdown behaviour this
// wiring delegates to in depth.
await import("./index.js");

const handler = registerTool.mock.calls[0]?.[2] as (args: {
  question: string;
}) => Promise<unknown>;

// Vitest clears every mock's recorded calls before each test runs, so the
// module-load-time call counts above have to be snapshotted here, in
// `beforeAll` (which runs before that per-test clearing), rather than read
// from `loadConfig`/`connect` directly inside an `it`.
let loadConfigCallsAtStartup = 0;
let connectCallsAtStartup = 0;
let registerToolArgsAtStartup: unknown[] | undefined;
beforeAll(() => {
  loadConfigCallsAtStartup = vi.mocked(loadConfig).mock.calls.length;
  connectCallsAtStartup = connect.mock.calls.length;
  registerToolArgsAtStartup = registerTool.mock.calls[0];
});

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("index.ts (stdio entrypoint)", () => {
  it("loads the config once, registers ask_by_phone, and connects the stdio transport", () => {
    expect(loadConfigCallsAtStartup).toBe(1);
    expect(registerToolArgsAtStartup?.[0]).toBe("ask_by_phone");
    expect(registerToolArgsAtStartup?.[2]).toEqual(expect.any(Function));
    expect(connectCallsAtStartup).toBe(1);
  });

  describe("shutdown", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        return undefined as never;
      });
      vi.mocked(cancelCall).mockReset().mockResolvedValue(undefined);
      vi.mocked(startCall).mockReset();
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it("cancels an in-flight call and exits on SIGINT", async () => {
      vi.mocked(startCall).mockReturnValue(new Promise(() => {})); // never resolves

      void handler({ question: "Deploy?" });
      await flushAsync();

      process.emit("SIGINT");
      await flushAsync();

      expect(cancelCall).toHaveBeenCalledWith(config, expect.any(String));
      expect(exitSpy).toHaveBeenCalledWith(130);
    });
  });
});
