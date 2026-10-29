#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import type { ConfigResult } from "./server.js";
import { registerAskByPhoneTool, registerShutdownHandlers } from "./server.js";

const DEFAULT_PORT = 8090;

/** Loaded once at startup; a configuration error is reported through each tool call's chat fallback. */
const configResult: ConfigResult = (() => {
  try {
    return { config: loadConfig() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
})();

/** Shared across every request, so a container stop/restart still hangs up anything in flight. */
const activeCalls = new Set<string>();
registerShutdownHandlers(configResult, activeCalls);

// Binds every interface inside the container; access control is the
// Tailscale ACL and the Compose port mapping, not a `Host` header check (the
// SDK's DNS-rebinding protection only recognises localhost-shaped hosts, and
// requests here arrive addressed to the tailnet name or IP).
const app = createMcpExpressApp({ host: "0.0.0.0" });

/**
 * A stateless MCP server per request: `ask_by_phone` has one tool call and no
 * use for session resumability, so there is no session store to keep.
 */
app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "phone-claude", version: "0.1.0" });
  registerAskByPhoneTool(server, configResult, activeCalls);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on("close", () => {
    transport.close();
    server.close();
  });
});

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
});

app.delete("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
});

const port = Number(process.env.MCP_PORT ?? DEFAULT_PORT);
/** Exported so tests can bind an ephemeral port (`MCP_PORT=0`) and read it back. */
export const server = app.listen(port, "0.0.0.0");
