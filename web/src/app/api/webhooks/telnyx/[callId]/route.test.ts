import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const speak = vi.fn();
const hangup = vi.fn();
const startTranscription = vi.fn();
const stopTranscription = vi.fn();

vi.mock("telnyx", () => ({
  default: vi.fn(function Telnyx() {
    return {
      calls: {
        actions: { speak, hangup, startTranscription, stopTranscription },
      },
    };
  }),
}));

vi.mock("@/lib/verify-telnyx-signature", () => ({
  verifyTelnyxSignature: vi.fn(() => true),
}));

vi.mock("@/lib/store", () => ({
  CallStore: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

const { verifyTelnyxSignature } = await import("@/lib/verify-telnyx-signature");
const { CallStore } = await import("@/lib/store");
const { POST } = await import("./route");

function request(body: unknown): NextRequest {
  return new NextRequest("https://example.com/api/webhooks/telnyx/call-1", {
    method: "POST",
    headers: {
      "telnyx-signature-ed25519": "sig",
      "telnyx-timestamp": "123",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ callId: "call-1" }) };
}

function event(eventType: string, payload: Record<string, unknown>) {
  return {
    data: {
      event_type: eventType,
      payload: { call_control_id: "cc-1", ...payload },
    },
  };
}

function promptState(): string {
  return Buffer.from("prompt", "utf-8").toString("base64");
}

function goodbyeState(): string {
  return Buffer.from("goodbye", "utf-8").toString("base64");
}

describe("POST /api/webhooks/telnyx/:callId", () => {
  beforeEach(() => {
    vi.stubEnv("TELNYX_API_KEY", "test-api-key");
    vi.stubEnv("TELNYX_PUBLIC_KEY", "test-public-key");
    vi.mocked(verifyTelnyxSignature).mockReturnValue(true);
    vi.mocked(CallStore.get).mockReset();
    vi.mocked(CallStore.update).mockReset();
    speak.mockReset().mockResolvedValue(undefined);
    hangup.mockReset().mockResolvedValue(undefined);
    startTranscription.mockReset().mockResolvedValue(undefined);
    stopTranscription.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("rejects an invalid signature", async () => {
    vi.mocked(verifyTelnyxSignature).mockReturnValue(false);

    const response = await POST(request(event("call.answered", {})), params());

    expect(response.status).toBe(401);
  });

  it("rejects when TELNYX_PUBLIC_KEY is unset", async () => {
    vi.stubEnv("TELNYX_PUBLIC_KEY", "");

    const response = await POST(request(event("call.answered", {})), params());

    expect(response.status).toBe(401);
  });

  it("speaks the question and context on call.answered", async () => {
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      context: "Staging is green.",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await POST(request(event("call.answered", {})), params());

    expect(speak).toHaveBeenCalledWith("cc-1", {
      payload: "Deploy now? Context: Staging is green.",
      voice: "female",
      service_level: "basic",
      language: "en-US",
      client_state: promptState(),
    });
  });

  it("speaks a goodbye without transcribing when the call record is gone", async () => {
    vi.mocked(CallStore.get).mockResolvedValue(null);

    await POST(request(event("call.answered", {})), params());

    expect(speak).toHaveBeenCalledWith("cc-1", {
      payload: "Sorry, this call is no longer valid. Goodbye.",
      voice: "female",
      service_level: "basic",
      language: "en-US",
      client_state: goodbyeState(),
    });
  });

  it("starts transcription once the question finishes playing", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.update).mockResolvedValue(null);

    const post = POST(
      request(event("call.speak.ended", { client_state: promptState() })),
      params(),
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await post;

    expect(startTranscription).toHaveBeenCalledWith("cc-1", {});
  });

  it("hangs up once the closing message finishes playing", async () => {
    await POST(
      request(event("call.speak.ended", { client_state: goodbyeState() })),
      params(),
    );

    expect(hangup).toHaveBeenCalledWith("cc-1", {});
  });

  it("marks the call failed and apologises if nothing is said in time", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.update).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "failed",
      error: "Call ended without a spoken answer (no input)",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const post = POST(
      request(event("call.speak.ended", { client_state: promptState() })),
      params(),
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await post;

    expect(CallStore.update).toHaveBeenCalledWith(
      "call-1",
      {
        status: "failed",
        error: "Call ended without a spoken answer (no input)",
      },
      { ifStatus: "pending" },
    );
    expect(stopTranscription).toHaveBeenCalledWith("cc-1", {});
    expect(speak).toHaveBeenCalledWith("cc-1", {
      payload: "Sorry, I didn't catch that. Goodbye.",
      voice: "female",
      service_level: "basic",
      language: "en-US",
      client_state: goodbyeState(),
    });
  });

  it("does not apologise if an answer already arrived before the timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.update).mockResolvedValue(null);

    const post = POST(
      request(event("call.speak.ended", { client_state: promptState() })),
      params(),
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await post;

    expect(speak).not.toHaveBeenCalled();
  });

  it("records a final transcript as the answer and speaks a closing message", async () => {
    vi.mocked(CallStore.update).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "answered",
      answer: "Ship it",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await POST(
      request(
        event("call.transcription", {
          transcription_data: { is_final: true, transcript: "Ship it" },
        }),
      ),
      params(),
    );

    expect(CallStore.update).toHaveBeenCalledWith(
      "call-1",
      { status: "answered", answer: "Ship it" },
      { ifStatus: "pending" },
    );
    expect(stopTranscription).toHaveBeenCalledWith("cc-1", {});
    expect(speak).toHaveBeenCalledWith("cc-1", {
      payload: "Got it, thanks. Goodbye.",
      voice: "female",
      service_level: "basic",
      language: "en-US",
      client_state: goodbyeState(),
    });
  });

  it("ignores an interim (non-final) transcription result", async () => {
    await POST(
      request(
        event("call.transcription", {
          transcription_data: { is_final: false, transcript: "Ship" },
        }),
      ),
      params(),
    );

    expect(CallStore.update).not.toHaveBeenCalled();
  });

  it("marks a still-pending call failed on a terminal hangup", async () => {
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await POST(
      request(event("call.hangup", { hangup_cause: "no_answer" })),
      params(),
    );

    expect(CallStore.update).toHaveBeenCalledWith("call-1", {
      status: "failed",
      error: "Call ended without a spoken answer (no_answer)",
    });
  });

  it("leaves an already-answered call untouched on hangup", async () => {
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "answered",
      answer: "Yes",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await POST(
      request(event("call.hangup", { hangup_cause: "normal_clearing" })),
      params(),
    );

    expect(CallStore.update).not.toHaveBeenCalled();
  });
});
