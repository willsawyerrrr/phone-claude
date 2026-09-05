import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth";
import { CallStore } from "@/lib/store";
import { getVoiceProvider } from "@/lib/providers";

const bodySchema = z.object({
  phoneNumber: z.string().min(1),
  question: z.string().min(1),
  context: z.string().optional(),
});

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { phoneNumber, question, context } = parsed.data;
  const callId = randomUUID();

  await CallStore.create({
    callId,
    phoneNumber,
    question,
    context,
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  try {
    const { providerCallId } = await getVoiceProvider().startCall({
      callId,
      phoneNumber,
      question,
      context,
    });
    await CallStore.update(callId, { providerCallId });
  } catch (error) {
    await CallStore.update(callId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Failed to start call",
    });
    return NextResponse.json(
      { error: "Failed to start call" },
      { status: 502 },
    );
  }

  return NextResponse.json({ callId });
}
