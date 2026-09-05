import type { StartCallParams, StartCallResult, VoiceProvider } from "./types";

const VAPI_API_URL = "https://api.vapi.ai/call";

/**
 * Starts an outbound call via Vapi's REST API. The assistant referenced by
 * `VAPI_ASSISTANT_ID` must be configured (in the Vapi dashboard) with a
 * system prompt that reads `{{question}}` / `{{context}}` and with
 * `end-of-call-report` enabled as a server message, see README.md.
 */
export class VapiProvider implements VoiceProvider {
  async startCall(params: StartCallParams): Promise<StartCallResult> {
    const apiKey = requireEnv("VAPI_API_KEY");
    const phoneNumberId = requireEnv("VAPI_PHONE_NUMBER_ID");
    const assistantId = requireEnv("VAPI_ASSISTANT_ID");

    const body: Record<string, unknown> = {
      assistantId,
      phoneNumberId,
      customer: { number: params.phoneNumber },
      metadata: { callId: params.callId },
      assistantOverrides: {
        variableValues: {
          question: params.question,
          context: params.context ?? "",
        },
        // Per-call server URL override, confirm this shape against
        // https://docs.vapi.ai/api-reference/calls/create — if unsupported,
        // set the webhook URL as the assistant's default server URL instead.
        ...(process.env.WEBHOOK_URL
          ? { server: { url: process.env.WEBHOOK_URL } }
          : {}),
      },
    };

    const response = await fetch(VAPI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Vapi call creation failed (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as { id: string };
    return { providerCallId: data.id };
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
