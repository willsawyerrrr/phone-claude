import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { CallStore } from "@/lib/store";

export async function GET(
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

  return NextResponse.json({
    status: record.status,
    answer: record.answer,
    error: record.error,
  });
}
