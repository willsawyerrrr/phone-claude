import { Twilio } from "twilio";
import { appUrl } from "@/lib/base-url";
import type { StartCallParams, StartCallResult, VoiceProvider } from "./types";

/**
 * Starts an outbound call via Twilio's REST API. Twilio fetches TwiML from
 * `/api/twiml/:callId` (`<Say>` for the question/context, `<Gather
 * input="speech">` to capture the spoken reply) and posts the Gather result,
 * plus a final call-status callback, to `/api/webhooks/twilio/:callId` —
 * see README.md.
 */
export class TwilioProvider implements VoiceProvider {
  async startCall(params: StartCallParams): Promise<StartCallResult> {
    const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
    const authToken = requireEnv("TWILIO_AUTH_TOKEN");
    const fromNumber = requireEnv("TWILIO_PHONE_NUMBER");

    const client = new Twilio(accountSid, authToken);
    const call = await client.calls.create({
      to: params.phoneNumber,
      from: fromNumber,
      url: appUrl(`/api/twiml/${params.callId}`),
      method: "GET",
      statusCallback: appUrl(`/api/webhooks/twilio/${params.callId}`),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed"],
    });

    return { providerCallId: call.sid };
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
