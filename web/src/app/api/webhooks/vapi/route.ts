import { NextRequest, NextResponse } from "next/server";
import { CallStore } from "@/lib/store";
import { verifyVapiSignature } from "@/lib/verify-vapi-signature";

interface VapiEndOfCallMessage {
  type: string;
  call?: { metadata?: { callId?: string } };
  analysis?: { summary?: string };
  transcript?: string;
  endedReason?: string;
}

export async function POST(request: NextRequest) {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  const rawBody = await request.text();

  if (!secret || !verifyVapiSignature(rawBody, request.headers, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as { message?: VapiEndOfCallMessage };
  const message = body.message;

  if (message?.type !== "end-of-call-report") {
    return NextResponse.json({ ok: true });
  }

  const callId = message.call?.metadata?.callId;
  if (!callId) {
    return NextResponse.json(
      { error: "Missing callId in metadata" },
      { status: 400 },
    );
  }

  const answer = message.analysis?.summary || message.transcript;

  if (answer) {
    await CallStore.update(callId, { status: "answered", answer });
  } else {
    await CallStore.update(callId, {
      status: "failed",
      error: message.endedReason ?? "Call ended without an answer",
    });
  }

  return NextResponse.json({ ok: true });
}
