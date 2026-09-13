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
  },
}));

const { verifyTwilioSignature } = await import("@/lib/verify-twilio-signature");
const { CallStore } = await import("@/lib/store");
const { GET } = await import("./route");

function request(): NextRequest {
  return new NextRequest("https://example.com/api/twiml/call-1", {
    headers: { "x-twilio-signature": "sig" },
  });
}

function params() {
  return { params: Promise.resolve({ callId: "call-1" }) };
}

describe("GET /api/twiml/:callId", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
    vi.mocked(verifyTwilioSignature).mockReturnValue(true);
    vi.mocked(CallStore.get).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an invalid signature", async () => {
    vi.mocked(verifyTwilioSignature).mockReturnValue(false);

    const response = await GET(request(), params());

    expect(response.status).toBe(401);
  });

  it("says the question and gathers speech, falling back to a goodbye", async () => {
    vi.mocked(CallStore.get).mockResolvedValue({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      context: "Staging is green.",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await GET(request(), params());
    const xml = await response.text();

    expect(response.headers.get("content-type")).toContain("text/xml");
    expect(xml).toContain("<Gather");
    expect(xml).toContain("Deploy now?");
    expect(xml).toContain("Staging is green.");
    expect(xml).toContain(
      'action="https://example.com/api/webhooks/twilio/call-1"',
    );
    expect(xml).toMatch(/didn.t catch that/);
  });

  it("says a goodbye without gathering when the call record is gone", async () => {
    vi.mocked(CallStore.get).mockResolvedValue(null);

    const response = await GET(request(), params());
    const xml = await response.text();

    expect(xml).not.toContain("<Gather");
    expect(xml).toContain("no longer valid");
  });
});
