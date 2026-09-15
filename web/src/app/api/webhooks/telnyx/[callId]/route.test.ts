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

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // The real `after` requires an actual Next.js request scope, which
  // calling the route handler directly (as these tests do) doesn't
  // provide. Running the callback immediately reproduces the same
  // observable behavior these tests assert on: fake timers still control
  // the `sleep` inside it.
  after: (fn: () => void) => fn(),
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
      voice: "Telnyx.KokoroTTS.af_heart",
      language: "en-US",
      client_state: promptState(),
    });
  });

  it("speaks a goodbye without transcribing when the call record is gone", async () => {
    vi.mocked(CallStore.get).mockResolvedValue(null);

    await POST(request(event("call.answered", {})), params());

    expect(speak).toHaveBeenCalledWith("cc-1", {
      payload: "Sorry, this call is no longer valid. Goodbye.",
      voice: "Telnyx.KokoroTTS.af_heart",
      language: "en-US",
      client_state: goodbyeState(),
    });
  });

  it("starts transcription once the question finishes playing", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      promptAttempt: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(CallStore.update).mockResolvedValue(null);

    const post = POST(
      request(event("call.speak.ended", { client_state: promptState() })),
      params(),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await post;

    expect(startTranscription).toHaveBeenCalledWith("cc-1", {});
  });

  it("does not restart transcription on a repeat's re-prompt", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      promptAttempt: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(CallStore.update).mockResolvedValue(null);

    const post = POST(
      request(event("call.speak.ended", { client_state: promptState() })),
      params(),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await post;

    expect(startTranscription).not.toHaveBeenCalled();
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
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      promptAttempt: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
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
    await vi.advanceTimersByTimeAsync(15_000);
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
      voice: "Telnyx.KokoroTTS.af_heart",
      language: "en-US",
      client_state: goodbyeState(),
    });
  });

  it("does not apologise if an answer already arrived before the timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      promptAttempt: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(CallStore.update).mockResolvedValue(null);

    const post = POST(
      request(event("call.speak.ended", { client_state: promptState() })),
      params(),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await post;

    expect(speak).not.toHaveBeenCalled();
  });

  it("buffers a transcript segment and finalizes it as the answer after the quiet period", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get)
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 1,
        transcriptSeq: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 1,
        pendingTranscript: "Ship it",
        transcriptSeq: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    vi.mocked(CallStore.update).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "answered",
      answer: "Ship it",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const post = POST(
      request(
        event("call.transcription", {
          transcription_data: { is_final: true, transcript: "Ship it" },
        }),
      ),
      params(),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await post;

    expect(CallStore.update).toHaveBeenCalledWith(
      "call-1",
      { pendingTranscript: "Ship it", transcriptSeq: 1 },
      { ifStatus: "pending" },
    );
    expect(CallStore.update).toHaveBeenCalledWith(
      "call-1",
      { status: "answered", answer: "Ship it" },
      { ifStatus: "pending" },
    );
    expect(stopTranscription).toHaveBeenCalledWith("cc-1", {});
    expect(speak).toHaveBeenCalledWith("cc-1", {
      payload: "Got it, thanks. Goodbye.",
      voice: "Telnyx.KokoroTTS.af_heart",
      language: "en-US",
      client_state: goodbyeState(),
    });
  });

  it("joins consecutive segments into one reply instead of acting on the first alone", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get)
      // handleTranscription reading the record for "sorry"
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 1,
        transcriptSeq: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      // handleTranscription reading the record for "can you repeat that",
      // arriving before "sorry"'s quiet period elapses
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 1,
        pendingTranscript: "sorry",
        transcriptSeq: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      // "sorry"'s own finalize call, after the full record now reflects seq 2
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 1,
        pendingTranscript: "sorry can you repeat that",
        transcriptSeq: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      // "can you repeat that"'s own finalize call
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        context: "Staging is green.",
        status: "pending",
        promptAttempt: 1,
        pendingTranscript: "sorry can you repeat that",
        transcriptSeq: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    vi.mocked(CallStore.update).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      promptAttempt: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const first = POST(
      request(
        event("call.transcription", {
          transcription_data: { is_final: true, transcript: "sorry" },
        }),
      ),
      params(),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await first;

    const second = POST(
      request(
        event("call.transcription", {
          transcription_data: {
            is_final: true,
            transcript: "can you repeat that",
          },
        }),
      ),
      params(),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await second;

    // The first segment's own finalize fired in that 3s advance too, but
    // found transcriptSeq had moved on and skipped it — only the combined
    // text is ever classified.
    expect(speak).toHaveBeenCalledWith("cc-1", {
      payload: "One more time. Deploy now? Context: Staging is green.",
      voice: "Telnyx.KokoroTTS.af_heart",
      language: "en-US",
      client_state: promptState(),
    });
    expect(speak).not.toHaveBeenCalledWith(
      "cc-1",
      expect.objectContaining({ payload: expect.stringContaining("sorry") }),
    );
  });

  it("repeats the question when the caller asks, without recording it as the answer", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get)
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        context: "Staging is green.",
        status: "pending",
        promptAttempt: 1,
        transcriptSeq: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        context: "Staging is green.",
        status: "pending",
        promptAttempt: 1,
        pendingTranscript: "Can you repeat that?",
        transcriptSeq: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    vi.mocked(CallStore.update).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      context: "Staging is green.",
      status: "pending",
      promptAttempt: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const post = POST(
      request(
        event("call.transcription", {
          transcription_data: {
            is_final: true,
            transcript: "Can you repeat that?",
          },
        }),
      ),
      params(),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await post;

    expect(stopTranscription).not.toHaveBeenCalled();
    expect(CallStore.update).toHaveBeenCalledWith(
      "call-1",
      {
        promptAttempt: 2,
        pendingTranscript: undefined,
        transcriptSeq: 0,
      },
      { ifStatus: "pending" },
    );
    expect(speak).toHaveBeenCalledWith("cc-1", {
      payload: "One more time. Deploy now? Context: Staging is green.",
      voice: "Telnyx.KokoroTTS.af_heart",
      language: "en-US",
      client_state: promptState(),
    });
  });

  it("stops repeating once the limit is reached and records it as the answer instead", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get)
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 3,
        transcriptSeq: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 3,
        pendingTranscript: "repeat please",
        transcriptSeq: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    vi.mocked(CallStore.update).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "answered",
      answer: "repeat please",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const post = POST(
      request(
        event("call.transcription", {
          transcription_data: { is_final: true, transcript: "repeat please" },
        }),
      ),
      params(),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await post;

    expect(CallStore.update).toHaveBeenCalledWith(
      "call-1",
      { status: "answered", answer: "repeat please" },
      { ifStatus: "pending" },
    );
  });

  it("does not apologise once the caller has started replying, even before it's finalized", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      promptAttempt: 1,
      transcriptSeq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(CallStore.update).mockResolvedValue(null);

    const post = POST(
      request(event("call.speak.ended", { client_state: promptState() })),
      params(),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await post;

    expect(CallStore.update).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });

  it("ignores a stale no-input timeout after a repeat starts a new listening window", async () => {
    vi.useFakeTimers();
    vi.mocked(CallStore.get)
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
        status: "pending",
        promptAttempt: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
      });

    const post = POST(
      request(event("call.speak.ended", { client_state: promptState() })),
      params(),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await post;

    expect(CallStore.update).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
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
