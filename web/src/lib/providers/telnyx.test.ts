import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dial = vi.fn();
const hangup = vi.fn();

vi.mock("telnyx", () => ({
  default: vi.fn(function Telnyx() {
    return { calls: { dial, actions: { hangup } } };
  }),
}));

vi.mock("@/lib/base-url", () => ({
  appUrl: (path: string) => `https://example.com${path}`,
}));

const { TelnyxProvider } = await import("./telnyx");

describe("TelnyxProvider.startCall", () => {
  beforeEach(() => {
    vi.stubEnv("TELNYX_API_KEY", "test-api-key");
    vi.stubEnv("TELNYX_CONNECTION_ID", "conn-test");
    vi.stubEnv("TELNYX_PHONE_NUMBER", "+10000000001");
    dial
      .mockReset()
      .mockResolvedValue({ data: { call_control_id: "cc-test" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dials the call and returns the call_control_id", async () => {
    const result = await new TelnyxProvider().startCall({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
    });

    expect(dial).toHaveBeenCalledWith({
      connection_id: "conn-test",
      to: "+10000000000",
      from: "+10000000001",
      webhook_url: "https://example.com/api/webhooks/telnyx/call-1",
    });
    expect(result).toEqual({ providerCallId: "cc-test" });
  });

  it("throws when Telnyx doesn't return a call_control_id", async () => {
    dial.mockResolvedValue({ data: undefined });

    await expect(
      new TelnyxProvider().startCall({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
      }),
    ).rejects.toThrow(/did not return a call_control_id/);
  });

  it("throws a clear error when required env vars are missing", async () => {
    vi.unstubAllEnvs();

    await expect(
      new TelnyxProvider().startCall({
        callId: "call-1",
        phoneNumber: "+10000000000",
        question: "Deploy now?",
      }),
    ).rejects.toThrow(/Missing required env var/);
  });
});

describe("TelnyxProvider.endCall", () => {
  beforeEach(() => {
    vi.stubEnv("TELNYX_API_KEY", "test-api-key");
    hangup.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("issues the hangup command", async () => {
    await new TelnyxProvider().endCall("cc-test");

    expect(hangup).toHaveBeenCalledWith("cc-test", {});
  });

  it("propagates a provider error (e.g. the call already ended)", async () => {
    hangup.mockRejectedValue(new Error("call not found"));

    await expect(new TelnyxProvider().endCall("cc-test")).rejects.toThrow(
      "call not found",
    );
  });

  it("throws a clear error when required env vars are missing", async () => {
    vi.unstubAllEnvs();

    await expect(new TelnyxProvider().endCall("cc-test")).rejects.toThrow(
      /Missing required env var/,
    );
  });
});
