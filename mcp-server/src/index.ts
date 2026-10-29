#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import type { ConfigResult } from "./server.js";
import { registerAskByPhoneTool, registerShutdownHandlers } from "./server.js";

/** Loaded once at startup; a configuration error is reported through each tool call's chat fallback. */
const configResult: ConfigResult = (() => {
  try {
    return { config: loadConfig() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
})();

const activeCalls = new Set<string>();
registerShutdownHandlers(configResult, activeCalls);

const server = new McpServer({
  name: "phone-claude",
  version: "0.1.0",
});
registerAskByPhoneTool(server, configResult, activeCalls);

const transport = new StdioServerTransport();
await server.connect(transport);
