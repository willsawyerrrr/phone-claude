import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/store", () => ({
  CallStore: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/providers", () => ({
  getVoiceProvider: vi.fn(),
}));

const { CallStore } = await import("@/lib/store");
const { getVoiceProvider } = await import("@/lib/providers");
const { POST } = await import("./route");

const endCall = vi.fn();

function request(): NextRequest {
  return new NextRequest("https://example.com/api/calls/call-1/cancel", {
    method: "POST",
    headers: { authorization: "Bearer test-secret" },
  });
}

function params() {
  return { params: Promise.resolve({ id: "call-1" }) };
}

const pendingRecord = {
  callId: "call-1",
  phoneNumber: "+10000000000",
  question: "Deploy now?",
  status: "pending" as const,
  providerCallId: "CA-test",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("POST /api/calls/:id/cancel", () => {
  beforeEach(() => {
    vi.stubEnv("API_SECRET", "test-secret");
    vi.mocked(CallStore.get).mockReset();
    vi.mocked(CallStore.update).mockReset();
    vi.mocked(getVoiceProvider).mockReset();
    endCall.mockReset().mockResolvedValue(undefined);
    vi.mocked(getVoiceProvider).mockReturnValue({
      startCall: vi.fn(),
      endCall,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an unauthorized request", async () => {
    vi.stubEnv("API_SECRET", "test-secret");
    const response = await POST(
      new NextRequest("https://example.com/api/calls/call-1/cancel", {
        method: "POST",
      }),
      params(),
    );

    expect(response.status).toBe(401);
    expect(CallStore.get).not.toHaveBeenCalled();
  });

  it("404s when the call doesn't exist", async () => {
    vi.mocked(CallStore.get).mockResolvedValue(null);

    const response = await POST(request(), params());

    expect(response.status).toBe(404);
  });

  it("no-ops on an already-terminal call without touching the provider", async () => {
    vi.mocked(CallStore.get).mockResolvedValue({
      ...pendingRecord,
      status: "answered",
      answer: "Yes",
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "answered" });
    expect(endCall).not.toHaveBeenCalled();
    expect(CallStore.update).not.toHaveBeenCalled();
  });

  it("ends the call and marks the record failed", async () => {
    vi.mocked(CallStore.get).mockResolvedValue(pendingRecord);
    vi.mocked(CallStore.update).mockResolvedValue({
      ...pendingRecord,
      status: "failed",
      error: "cancelled: caller stopped waiting",
    });

    const response = await POST(request(), params());

    expect(endCall).toHaveBeenCalledWith("CA-test");
    expect(CallStore.update).toHaveBeenCalledWith(
      "call-1",
      { status: "failed", error: "cancelled: caller stopped waiting" },
      { ifStatus: "pending" },
    );
    expect(await response.json()).toEqual({ status: "failed" });
    expect(response.status).toBe(200);
  });

  it("still marks the record failed when the provider call already ended", async () => {
    endCall.mockRejectedValue(new Error("call not found"));
    vi.mocked(CallStore.get).mockResolvedValue(pendingRecord);
    vi.mocked(CallStore.update).mockResolvedValue({
      ...pendingRecord,
      status: "failed",
      error: "cancelled: caller stopped waiting",
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "failed" });
  });

  it("reports the actual outcome when the record moved past pending during cancellation", async () => {
    vi.mocked(CallStore.get)
      .mockResolvedValueOnce(pendingRecord)
      .mockResolvedValueOnce({
        ...pendingRecord,
        status: "answered",
        answer: "Yes",
      });
    vi.mocked(CallStore.update).mockResolvedValue(null);

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "answered" });
  });
});
