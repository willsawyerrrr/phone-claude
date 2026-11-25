import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAuth, type GoogleDeps } from "./auth.js";
import type { AuthConfig } from "./config.js";
import type { ConfigResult } from "./server.js";
import { registerAskByPhoneTool } from "./server.js";

function methodNotAllowed(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}

/**
 * The OAuth endpoints plus `/mcp`, which requires a bearer token they issued.
 * Each `/mcp` request gets its own stateless MCP server: `ask_by_phone` has
 * one tool call and no use for session resumability.
 */
export function createApp(
  configResult: ConfigResult,
  activeCalls: Set<string>,
  authConfig: AuthConfig,
  google?: GoogleDeps,
): Express {
  // Only `PUBLIC_URL`'s host is accepted, which also guards against DNS rebinding.
  const app = createMcpExpressApp({
    allowedHosts: [authConfig.publicUrl.hostname],
  });
  // Caddy is the one proxy in front, so the client IP (for the OAuth
  // endpoints' rate limits) is the last `X-Forwarded-For` hop.
  app.set("trust proxy", 1);

  const { router, requireAuth } = createAuth(authConfig, google);
  app.use(router);

  app.post("/mcp", requireAuth, async (req, res) => {
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

  app.get("/mcp", requireAuth, (_req, res) => {
    res.writeHead(405).end(methodNotAllowed());
  });

  app.delete("/mcp", requireAuth, (_req, res) => {
    res.writeHead(405).end(methodNotAllowed());
  });

  return app;
}
