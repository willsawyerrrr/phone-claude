import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { CallStore } from "@/lib/store";
import { getVoiceProvider } from "@/lib/providers";

const CANCEL_REASON = "cancelled: caller stopped waiting";

/**
 * Ends a call the caller (`mcp-server`) is no longer waiting on — it timed
 * out, or the process asking for it was interrupted. No-ops on a call
 * that's already terminal, since there's nothing left to cancel. Otherwise
 * asks the voice provider to end the call and marks the record `failed`;
 * a provider error (e.g. the call already ended on its side) doesn't
 * surface as a failure here, since the outcome — the call is no longer
 * outstanding — is the same either way.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const record = await CallStore.get(id);
  if (!record) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }

  if (record.status !== "pending") {
    return NextResponse.json({ status: record.status });
  }

  if (record.providerCallId) {
    try {
      await getVoiceProvider().endCall(record.providerCallId);
    } catch {
      // The call may already be over on the provider's side; still mark
      // the record failed below.
    }
  }

  const updated = await CallStore.update(
    id,
    { status: "failed", error: CANCEL_REASON },
    { ifStatus: "pending" },
  );
  if (updated) {
    return NextResponse.json({ status: updated.status });
  }

  // The record moved past `pending` (e.g. the webhook recorded an answer)
  // while the cancellation was in flight — report its actual outcome.
  const latest = await CallStore.get(id);
  return NextResponse.json({ status: latest?.status ?? record.status });
}
