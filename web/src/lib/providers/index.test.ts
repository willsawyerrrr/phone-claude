import { describe, expect, it, afterEach, vi } from "vitest";
import { getVoiceProvider } from "./index";
import { TwilioProvider } from "./twilio";

describe("getVoiceProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to Twilio when VOICE_PROVIDER is unset", () => {
    delete process.env.VOICE_PROVIDER;
    expect(getVoiceProvider()).toBeInstanceOf(TwilioProvider);
  });

  it("selects Twilio explicitly", () => {
    vi.stubEnv("VOICE_PROVIDER", "twilio");
    expect(getVoiceProvider()).toBeInstanceOf(TwilioProvider);
  });

  it("throws a clear error for an unimplemented provider", () => {
    vi.stubEnv("VOICE_PROVIDER", "retell");
    expect(() => getVoiceProvider()).toThrow(
      /Unsupported VOICE_PROVIDER: retell/,
    );
  });
});
