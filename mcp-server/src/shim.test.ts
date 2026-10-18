import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const shim = fileURLToPath(
  new URL("../../bin/phone-claude-mcp-server.js", import.meta.url),
);

it("serves MCP over stdio from the repo-root shim", async () => {
  const child = spawn("node", [shim], {
    env: { ...process.env, ARI_USERNAME: "u", ARI_PASSWORD: "p" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const send = (message: object) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const receive = async () => JSON.parse(String((await lines.next()).value));

  try {
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect((await receive()).result.serverInfo).toBeDefined();

    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    const { result } = await receive();
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
      "ask_by_phone",
    ]);
  } finally {
    child.kill();
  }
}, 120_000);
