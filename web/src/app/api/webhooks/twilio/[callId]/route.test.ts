import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/base-url", () => ({
  appUrl: (path: string) => `https://example.com${path}`,
}));

vi.mock("@/lib/verify-twilio-signature", () => ({
  verifyTwilioSignature: vi.fn(() => true),
}));

vi.mock("@/lib/store", () => ({
  CallStore: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

const { verifyTwilioSignature } = await import("@/lib/verify-twilio-signature");
const { CallStore } = await import("@/lib/store");
const { POST } = await import("./route");

function request(body: Record<string, string>): NextRequest {
  return new NextRequest("https://example.com/api/webhooks/twilio/call-1", {
    method: "POST",
    headers: {
      "x-twilio-signature": "sig",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
}

function params() {
  return { params: Promise.resolve({ callId: "call-1" }) };
}

describe("POST /api/webhooks/twilio/:callId", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
    vi.mocked(verifyTwilioSignature).mockReturnValue(true);
    vi.mocked(CallStore.get).mockReset();
    vi.mocked(CallStore.update).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an invalid signature", async () => {
    vi.mocked(verifyTwilioSignature).mockReturnValue(false);

    const response = await POST(request({ SpeechResult: "Yes" }), params());

    expect(response.status).toBe(401);
    expect(CallStore.update).not.toHaveBeenCalled();
  });

  it("rejects when TWILIO_AUTH_TOKEN is unset", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");

    const response = await POST(request({ SpeechResult: "Yes" }), params());

    expect(response.status).toBe(401);
  });

  it("records the answer from SpeechResult and replies with TwiML", async () => {
    const response = await POST(
      request({ SpeechResult: "Ship it", CallStatus: "in-progress" }),
      params(),
    );

    expect(CallStore.update).toHaveBeenCalledWith("call-1", {
      status: "answered",
      answer: "Ship it",
    });
    expect(response.headers.get("content-type")).toContain("text/xml");
    expect(await response.text()).toContain("<Response>");
  });

  it("marks a still-pending call failed once the call ends without an answer", async () => {
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await POST(request({ CallStatus: "no-answer" }), params());

    expect(CallStore.update).toHaveBeenCalledWith("call-1", {
      status: "failed",
      error: expect.stringContaining("no-answer"),
    });
    expect(response.status).toBe(200);
  });

  it("leaves an already-answered call untouched on the final status callback", async () => {
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "answered",
      answer: "Yes",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await POST(request({ CallStatus: "completed" }), params());

    expect(CallStore.update).not.toHaveBeenCalled();
  });

  it("does nothing for a mid-call request with no speech result yet", async () => {
    await POST(request({ CallStatus: "in-progress" }), params());

    expect(CallStore.update).not.toHaveBeenCalled();
    expect(CallStore.get).not.toHaveBeenCalled();
  });
});
