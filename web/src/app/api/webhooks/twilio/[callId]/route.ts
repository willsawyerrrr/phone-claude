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
 * Receives two kinds of Twilio callback for a call, both form-encoded:
 * the `<Gather>` result (`SpeechResult`), which marks the `CallRecord`
 * `answered`; and the final call-status callback (subscribed to the
 * `completed` event only, so it always reports a terminal `CallStatus`),
 * which marks the record `failed` if it is still `pending` — the call
 * ended without a spoken answer.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const { callId } = await params;
  const rawBody = await request.text();
  const formParams = Object.fromEntries(new URLSearchParams(rawBody));
  const url = appUrl(`/api/webhooks/twilio/${callId}`);

  if (
    !authToken ||
    !verifyTwilioSignature(request.headers, url, formParams, authToken)
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const speechResult = formParams.SpeechResult;
  if (speechResult) {
    await CallStore.update(callId, {
      status: "answered",
      answer: speechResult,
    });

    const response = new Twiml.VoiceResponse();
    response.say("Got it, thanks. Goodbye.");
    return xmlResponse(response);
  }

  if (formParams.CallStatus && formParams.CallStatus !== "in-progress") {
    const existing = await CallStore.get(callId);
    if (existing?.status === "pending") {
      await CallStore.update(callId, {
        status: "failed",
        error: `Call ended without a spoken answer (${formParams.CallStatus})`,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
