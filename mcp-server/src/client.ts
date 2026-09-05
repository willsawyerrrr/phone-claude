import type { Config } from "./config.js";

interface StartCallResponse {
  callId: string;
}

interface CallStatusResponse {
  status: "pending" | "answered" | "failed";
  answer?: string;
  error?: string;
}

export async function startCall(
  config: Config,
  question: string,
  context?: string,
): Promise<string> {
  const response = await fetch(`${config.apiUrl}/api/calls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumber: config.userPhoneNumber,
      question,
      context,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to start call (${response.status}): ${await response.text()}`,
    );
  }

  const { callId } = (await response.json()) as StartCallResponse;
  return callId;
}

/**
 * Polls for the call outcome rather than holding a long-lived connection —
 * calls take minutes and the MCP stdio transport has no server-push
 * mechanism, so a short interval poll is the simplest way to wait without
 * blocking the process on an open socket.
 */
export async function pollForAnswer(
  config: Config,
  callId: string,
): Promise<string> {
  const deadline = Date.now() + config.maxWaitMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${config.apiUrl}/api/calls/${callId}`, {
      headers: { Authorization: `Bearer ${config.apiSecret}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to poll call status (${response.status})`);
    }

    const status = (await response.json()) as CallStatusResponse;

    if (status.status === "answered") {
      return status.answer ?? "";
    }
    if (status.status === "failed") {
      throw new Error(status.error ?? "Call failed");
    }

    await sleep(config.pollIntervalMs);
  }

  throw new Error(
    `Timed out after ${config.maxWaitMs}ms waiting for an answer`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
