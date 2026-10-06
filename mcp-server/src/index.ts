#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { cancelCall, pollForAnswer, startCall } from "./client.js";

/** Loaded once at startup; a configuration error is reported through each tool call's chat fallback. */
const configResult: { config: Config } | { error: Error } = (() => {
  try {
    return { config: loadConfig() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
})();

const server = new McpServer({
  name: "phone-claude",
  version: "0.1.0",
});

/** IDs of the calls in flight, from before their first request until they finish. */
const activeCalls = new Set<string>();

/**
 * Cancels every in-flight call, then exits — run on `SIGINT`/`SIGTERM` so an
 * interrupted `ask_by_phone` doesn't leave the phone ringing after the
 * process that was waiting on it is gone. `cancelCall` bounds its own
 * requests with a timeout, so this can't hang process shutdown.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if ("config" in configResult) {
    const { config } = configResult;
    await Promise.all([...activeCalls].map((id) => cancelCall(config, id)));
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function fallback(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: `Could not get a phone answer (${message}). Ask the user in chat instead.`,
      },
    ],
    isError: true,
  };
}

server.registerTool(
  "ask_by_phone",
  {
    title: "Ask by phone",
    description:
      "Calls the user's phone to ask a question and waits for their spoken answer. " +
      "Use this when blocked on a decision only the user can make and they are " +
      "likely away from the keyboard (e.g. no response in chat, or they've said " +
      "they're stepping away). Not for questions answerable in-chat.",
    inputSchema: {
      question: z
        .string()
        .describe("The question to ask the user, read aloud verbatim"),
      context: z
        .string()
        .optional()
        .describe("Background the user needs to answer"),
    },
  },
  async ({ question, context }) => {
    if ("error" in configResult) return fallback(configResult.error);
    const { config } = configResult;

    const callId = randomUUID();
    activeCalls.add(callId);
    try {
      await startCall(config, callId, question, context);
      const answer = await pollForAnswer(config, callId);
      return { content: [{ type: "text", text: answer }] };
    } catch (error) {
      return fallback(error);
    } finally {
      activeCalls.delete(callId);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
