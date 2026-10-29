import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";

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

vi.mock("./client.js", () => ({
  startCall: vi.fn(),
  pollForAnswer: vi.fn(),
  cancelCall: vi.fn(),
}));

const { startCall, pollForAnswer } = await import("./client.js");

process.env.MCP_PORT = "0";
const { server } = await import("./http.js");

let baseUrl: string;

beforeAll(async () => {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", resolve));
  }
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function initialize(): Promise<void> {
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    }),
  });
}

async function callAskByPhone(args: {
  question: string;
  context?: string;
}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_by_phone", arguments: args },
    }),
  });
  return { status: response.status, body: await response.json() };
}

describe("POST /mcp", () => {
  it("runs ask_by_phone statelessly, independent of the initialize handshake", async () => {
    vi.mocked(startCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(pollForAnswer).mockReset().mockResolvedValue("Yes");
    await initialize();

    const { status, body } = await callAskByPhone({ question: "Deploy?" });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      result: { content: [{ type: "text", text: "Yes" }] },
    });
  });

  it("falls back to chat when the call fails", async () => {
    vi.mocked(startCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(pollForAnswer)
      .mockReset()
      .mockRejectedValue(new Error("fetch failed"));

    const { body } = await callAskByPhone({ question: "Deploy?" });

    expect(body).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "Could not get a phone answer (fetch failed). Ask the user in chat instead.",
          },
        ],
      },
    });
  });
});

describe("GET, DELETE /mcp", () => {
  it.each(["GET", "DELETE"])("returns 405 for %s", async (method) => {
    const response = await fetch(`${baseUrl}/mcp`, { method });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32000 },
    });
  });
});
