import type { StartCallParams, StartCallResult, VoiceProvider } from "./types";

const VAPI_API_URL = "https://api.vapi.ai/call";

/**
 * Name of the function tool the assistant calls once it has the user's
 * answer. Must match the tool configured on the assistant in the Vapi
 * dashboard/API, see README.md.
 */
export const RECORD_ANSWER_TOOL_NAME = "record_answer";

/**
 * Starts an outbound call via Vapi's REST API. The assistant referenced by
 * `VAPI_ASSISTANT_ID` must be configured with a system prompt that reads
 * `{{question}}` / `{{context}}`, a `record_answer` function tool, and a
 * `server` (url + credentialId) pointing at this app's webhook — see
 * README.md. The webhook URL/auth live on the assistant itself rather than
 * as a per-call override, since overriding `server` per call would drop the
 * assistant's `credentialId` and leave the webhook unauthenticated.
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
