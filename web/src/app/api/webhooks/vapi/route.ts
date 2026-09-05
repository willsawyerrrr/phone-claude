import { NextRequest, NextResponse } from "next/server";
import { CallStore } from "@/lib/store";
import { verifyVapiSecret } from "@/lib/verify-vapi-secret";
import { RECORD_ANSWER_TOOL_NAME } from "@/lib/providers/vapi";

interface ToolCall {
  id: string;
  function: { name: string; arguments: { answer?: string } | string };
}

interface VapiMessage {
  type: string;
  call?: { metadata?: { callId?: string } };
  toolCallList?: ToolCall[];
  endedReason?: string;
}

function parseAnswer(
  args: ToolCall["function"]["arguments"],
): string | undefined {
  const parsed = typeof args === "string" ? JSON.parse(args) : args;
  return parsed?.answer;
}

export async function POST(request: NextRequest) {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  const rawBody = await request.text();

  if (!secret || !verifyVapiSecret(request.headers, secret)) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as { message?: VapiMessage };
  const message = body.message;
  const callId = message?.call?.metadata?.callId;

  if (!callId) {
    return NextResponse.json({ ok: true });
  }

  if (message?.type === "tool-calls") {
    const call = message.toolCallList?.find(
      (c) => c.function.name === RECORD_ANSWER_TOOL_NAME,
    );
    const answer = call && parseAnswer(call.function.arguments);

    if (call && answer) {
      await CallStore.update(callId, { status: "answered", answer });
    }

    return NextResponse.json({
      results: message.toolCallList?.map((c) => ({
        toolCallId: c.id,
        result: "Recorded.",
      })),
    });
  }

  if (message?.type === "end-of-call-report") {
    const existing = await CallStore.get(callId);
    if (existing?.status === "pending") {
      await CallStore.update(callId, {
        status: "failed",
        error: message.endedReason ?? "Call ended without an answer",
      });
    }
  }

  return NextResponse.json({ ok: true });
}
