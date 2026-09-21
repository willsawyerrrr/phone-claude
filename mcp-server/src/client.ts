import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";

const CANCEL_TIMEOUT_MS = 5_000;

interface CallStatusResponse {
  status: "pending" | "answered" | "failed";
  answer?: string;
  error?: string;
}

/**
 * Places a call: registers the prompt with the voice pipeline, then has
 * Asterisk originate the call to the soft-phone via ARI. The call ID is a
 * UUID because Asterisk's AudioSocket keys the audio stream by one; it also
 * names the ARI channel, so the call can be hung up without tracking a
 * separate channel ID. The prompt is registered first so it's in place by the
 * time the phone answers and AudioSocket connects.
 */
export async function startCall(
  config: Config,
  question: string,
  context?: string,
): Promise<string> {
  const callId = randomUUID();

  const register = await fetch(`${config.pipelineUrl}/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId, question, context }),
  });
  if (!register.ok) {
    throw new Error(
      `Failed to register call (${register.status}): ${await register.text()}`,
    );
  }

  const originate = await fetch(
    `${config.ariUrl}/ari/channels?${new URLSearchParams({
      endpoint: `PJSIP/${config.sipEndpoint}`,
      context: config.dialplanContext,
      extension: config.dialplanExtension,
      priority: "1",
      channelId: callId,
    })}`,
    {
      method: "POST",
      headers: {
        Authorization: ariAuthorization(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ variables: { CALL_ID: callId } }),
    },
  );
  if (!originate.ok) {
    const detail = await originate.text();
    await cancelPipelineCall(config, callId);
    throw new Error(
      `Failed to originate call (${originate.status}): ${detail}`,
    );
  }

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
    const response = await fetch(`${config.pipelineUrl}/calls/${callId}`);

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
 * Hangs up a call that's no longer being waited on — the poll timed out, or
 * the process is shutting down — by dropping the ARI channel and marking the
 * call cancelled in the pipeline. Best-effort: swallows any error (including
 * a bounded request timing out itself, or the channel already being gone)
 * since there's no one left to report a cancellation failure to, and the call
 * will still resolve to `failed` on its own once it ends.
 */
export async function cancelCall(
  config: Config,
  callId: string,
): Promise<void> {
  await Promise.all([
    bestEffort(
      fetch(`${config.ariUrl}/ari/channels/${callId}`, {
        method: "DELETE",
        headers: { Authorization: ariAuthorization(config) },
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      }),
    ),
    cancelPipelineCall(config, callId),
  ]);
}

function cancelPipelineCall(config: Config, callId: string): Promise<void> {
  return bestEffort(
    fetch(`${config.pipelineUrl}/calls/${callId}/cancel`, {
      method: "POST",
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    }),
  );
}

async function bestEffort(request: Promise<Response>): Promise<void> {
  try {
    await request;
  } catch {
    // Best-effort — see `cancelCall`.
  }
}

function ariAuthorization(config: Config): string {
  const credentials = `${config.ariUsername}:${config.ariPassword}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
