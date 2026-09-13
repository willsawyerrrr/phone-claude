import type { Config } from "./config.js";

const CANCEL_TIMEOUT_MS = 5_000;

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

  await cancelCall(config, callId);
  throw new Error(
    `Timed out after ${config.maxWaitMs}ms waiting for an answer`,
  );
}

/**
 * Tells `web` to hang up a call that's no longer being waited on — the poll
 * timed out, or the process is shutting down. Best-effort: swallows any
 * error (including the bounded request timing out itself) since there's no
 * one left to report a cancellation failure to, and the call will still
 * resolve to `failed` on its own once it ends.
 */
export async function cancelCall(
  config: Config,
  callId: string,
): Promise<void> {
  try {
    await fetch(`${config.apiUrl}/api/calls/${callId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiSecret}` },
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    });
  } catch {
    // Best-effort — see doc comment above.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
