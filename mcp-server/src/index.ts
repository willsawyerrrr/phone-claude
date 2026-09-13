#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { cancelCall, pollForAnswer, startCall } from "./client.js";

const server = new McpServer({
  name: "phone-claude",
  version: "0.1.0",
});

/** The call currently being polled for, if any — set only while a call is in flight. */
let activeCall: { config: Config; callId: string } | null = null;

/**
 * Cancels the in-flight call, if any, then exits — run on `SIGINT`/`SIGTERM`
 * so an interrupted `ask_by_phone` doesn't leave the phone ringing after the
 * process that was waiting on it is gone. `cancelCall` bounds its own
 * request with a timeout, so this can't hang process shutdown.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (activeCall) {
    await cancelCall(activeCall.config, activeCall.callId);
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

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
    const config = loadConfig();

    try {
      const callId = await startCall(config, question, context);
      activeCall = { config, callId };
      const answer = await pollForAnswer(config, callId);
      return { content: [{ type: "text", text: answer }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Could not get a phone answer (${message}). Ask the user in chat instead.`,
          },
        ],
        isError: true,
      };
    } finally {
      activeCall = null;
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
