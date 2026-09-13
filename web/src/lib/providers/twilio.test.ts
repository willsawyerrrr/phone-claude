import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();
const calls = vi.fn(() => ({ update }));

vi.mock("twilio", () => ({
  Twilio: vi.fn(function Twilio() {
    return { calls };
  }),
}));

const { TwilioProvider } = await import("./twilio");

describe("TwilioProvider.endCall", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
    update.mockReset().mockResolvedValue(undefined);
    calls.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("updates the call resource to completed", async () => {
    await new TwilioProvider().endCall("CA-test");

    expect(calls).toHaveBeenCalledWith("CA-test");
    expect(update).toHaveBeenCalledWith({ status: "completed" });
  });

  it("propagates a provider error (e.g. the call already ended)", async () => {
    update.mockRejectedValue(new Error("call not found"));

    await expect(new TwilioProvider().endCall("CA-test")).rejects.toThrow(
      "call not found",
    );
  });

  it("throws a clear error when required env vars are missing", async () => {
    vi.unstubAllEnvs();

    await expect(new TwilioProvider().endCall("CA-test")).rejects.toThrow(
      /Missing required env var/,
    );
  });
});
