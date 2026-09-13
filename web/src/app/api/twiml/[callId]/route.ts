import { twiml as Twiml } from "twilio";
import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/base-url";
import { CallStore } from "@/lib/store";
import { verifyTwilioSignature } from "@/lib/verify-twilio-signature";

function xmlResponse(response: Twiml.VoiceResponse): NextResponse {
  return new NextResponse(response.toString(), {
    headers: { "Content-Type": "text/xml" },
  });
}

/**
 * Returns the TwiML Twilio requests when the call connects: `<Say>` the
 * question (and context, if any), then `<Gather input="speech">` the
 * spoken reply. No input before the timeout falls through to a goodbye
 * `<Say>`, ending the call; the `<Gather>` result (or lack of one) is
 * reported to `/api/webhooks/twilio/:callId`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const { callId } = await params;
  const url = appUrl(`/api/twiml/${callId}`);

  if (
    !authToken ||
    !verifyTwilioSignature(request.headers, url, {}, authToken)
  ) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const record = await CallStore.get(callId);
  const response = new Twiml.VoiceResponse();

  if (!record) {
    response.say("Sorry, this call is no longer valid. Goodbye.");
    return xmlResponse(response);
  }

  const prompt = record.context
    ? `${record.question} Context: ${record.context}`
    : record.question;

  const gather = response.gather({
    input: ["speech"],
    action: appUrl(`/api/webhooks/twilio/${callId}`),
    method: "POST",
    speechTimeout: "auto",
    timeout: 8,
  });
  gather.say(prompt);
  response.say("Sorry, I didn't catch that. Goodbye.");

  return xmlResponse(response);
}
