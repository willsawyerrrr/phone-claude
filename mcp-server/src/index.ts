#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { pollForAnswer, startCall } from "./client.js";

const server = new McpServer({
  name: "phone-claude",
  version: "0.1.0",
});

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
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
