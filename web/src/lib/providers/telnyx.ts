import Telnyx from "telnyx";
import { appUrl } from "@/lib/base-url";
import type { StartCallParams, StartCallResult, VoiceProvider } from "./types";

/**
 * Starts an outbound call via Telnyx's Call Control API. Telnyx POSTs call
 * events (`call.answered`, `call.speak.ended`, `call.transcription`,
 * `call.hangup`, ...) to `/api/webhooks/telnyx/:callId`, which drives the
 * call forward — speaking the question, capturing the spoken reply via
 * real-time transcription, and hanging up — by issuing Call Control
 * commands against those events as they arrive. See README.md.
 */
export class TelnyxProvider implements VoiceProvider {
  async startCall(params: StartCallParams): Promise<StartCallResult> {
    const apiKey = requireEnv("TELNYX_API_KEY");
    const connectionId = requireEnv("TELNYX_CONNECTION_ID");
    const fromNumber = requireEnv("TELNYX_PHONE_NUMBER");

    const client = new Telnyx({ apiKey });
    const { data } = await client.calls.dial({
      connection_id: connectionId,
      to: params.phoneNumber,
      from: fromNumber,
      webhook_url: appUrl(`/api/webhooks/telnyx/${params.callId}`),
    });

    if (!data?.call_control_id) {
      throw new Error("Telnyx did not return a call_control_id");
    }

    return { providerCallId: data.call_control_id };
  }

  async endCall(providerCallId: string): Promise<void> {
    const apiKey = requireEnv("TELNYX_API_KEY");

    const client = new Telnyx({ apiKey });
    await client.calls.actions.hangup(providerCallId, {});
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
