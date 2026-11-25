#!/usr/bin/env node
import { createApp } from "./app.js";
import { loadAuthConfig, loadConfig } from "./config.js";
import type { ConfigResult } from "./server.js";
import { registerShutdownHandlers } from "./server.js";

const DEFAULT_PORT = 8090;

/** Loaded once at startup; a configuration error is reported through each tool call's chat fallback. */
const configResult: ConfigResult = (() => {
  try {
    return { config: loadConfig() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
})();

/** Throws on a missing or invalid setting, so `/mcp` is never served unauthenticated. */
const authConfig = loadAuthConfig();

/** Shared across every request, so a container stop/restart still hangs up anything in flight. */
const activeCalls = new Set<string>();
registerShutdownHandlers(configResult, activeCalls);

const app = createApp(configResult, activeCalls, authConfig);

const port = Number(process.env.MCP_PORT ?? DEFAULT_PORT);
/** Exported so tests can bind an ephemeral port (`MCP_PORT=0`) and read it back. */
export const server = app.listen(port, "0.0.0.0");
