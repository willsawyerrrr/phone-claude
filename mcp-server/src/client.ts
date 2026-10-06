import type { Config } from "./config.js";

const CANCEL_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface CallStatusResponse {
  status: "pending" | "answered" | "failed";
  answer?: string;
  error?: string;
}

/**
 * Places a call: registers the prompt with the voice pipeline, then has
 * Asterisk originate the call to the soft-phone via ARI. The caller supplies
 * the call ID (a UUID, because Asterisk's AudioSocket keys the audio stream
 * by one) so it can track and cancel the call from before the first request.
 * It also names the ARI channel, so the call can be hung up without tracking
 * a separate channel ID. The prompt is registered first so it's in place by
 * the time the phone answers and AudioSocket connects. Any failure hangs up
 * whatever was started before it is thrown.
 */
export async function startCall(
  config: Config,
  callId: string,
  question: string,
  context?: string,
): Promise<void> {
  try {
    const register = await fetch(`${config.pipelineUrl}/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId, question, context }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!originate.ok) {
      throw new Error(
        `Failed to originate call (${originate.status}): ${await originate.text()}`,
      );
    }
  } catch (error) {
    await cancelCall(config, callId);
    throw error;
  }
}

/**
 * Polls for the call outcome rather than holding a long-lived connection —
 * calls take minutes and the MCP stdio transport has no server-push
 * mechanism, so a short interval poll is the simplest way to wait without
 * blocking the process on an open socket.
 *
 * Nothing tells the pipeline when the dial itself fails (busy, declined,
 * unreachable), so its record stays `pending`. While `pending`, each poll
 * also checks the ARI channel: a missing channel means the call is over, so
 * after re-reading the status once to rule out a call that just completed,
 * the call is reported as failed rather than waited on until `maxWaitMs`.
 */
export async function pollForAnswer(
  config: Config,
  callId: string,
): Promise<string> {
  const deadline = Date.now() + config.maxWaitMs;

  try {
    while (Date.now() < deadline) {
      let status = await fetchCallStatus(config, callId);

      if (
        status.status === "pending" &&
        (await channelIsGone(config, callId))
      ) {
        status = await fetchCallStatus(config, callId);
        if (status.status === "pending") {
          throw new Error("The phone was busy, declined, or did not answer");
        }
      }

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
  } catch (error) {
    await cancelCall(config, callId);
    throw error;
  }
}

async function fetchCallStatus(
  config: Config,
  callId: string,
): Promise<CallStatusResponse> {
  const response = await fetch(`${config.pipelineUrl}/calls/${callId}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to poll call status (${response.status})`);
  }
  return (await response.json()) as CallStatusResponse;
}

/**
 * Whether ARI reports the call's channel as gone (a 404). Any other outcome,
 * including an unreachable ARI, counts as "not known to be gone" so a
 * transient ARI problem never fails a live call.
 */
async function channelIsGone(config: Config, callId: string): Promise<boolean> {
  try {
    const response = await fetch(`${config.ariUrl}/ari/channels/${callId}`, {
      headers: { Authorization: ariAuthorization(config) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.status === 404;
  } catch {
    return false;
  }
}

/**
 * Hangs up a call that's no longer being waited on — starting or polling it
 * failed, or the process is shutting down — by dropping the ARI channel and marking the
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
