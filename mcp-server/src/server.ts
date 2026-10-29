import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { cancelCall, pollForAnswer, startCall } from "./client.js";

/** Either a loaded config, or the error loading it threw. */
export type ConfigResult = { config: Config } | { error: Error };

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

/**
 * Registers the `ask_by_phone` tool on `server`, tracking each call's ID in
 * `activeCalls` from before its first request until it finishes. A
 * `configResult` error is reported through the tool's own chat fallback
 * rather than thrown, so a misconfigured process can still start and explain
 * itself.
 */
export function registerAskByPhoneTool(
  server: McpServer,
  configResult: ConfigResult,
  activeCalls: Set<string>,
): void {
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
}

/**
 * Cancels every in-flight call, then exits — run on `SIGINT`/`SIGTERM` so an
 * interrupted `ask_by_phone` doesn't leave the phone ringing after the
 * process that was waiting on it is gone. `cancelCall` bounds its own
 * requests with a timeout, so this can't hang process shutdown.
 */
export function registerShutdownHandlers(
  configResult: ConfigResult,
  activeCalls: Set<string>,
): void {
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if ("config" in configResult) {
      const { config } = configResult;
      await Promise.all([...activeCalls].map((id) => cancelCall(config, id)));
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
