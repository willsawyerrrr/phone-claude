import { describe, expect, it, afterEach, vi } from "vitest";
import { getVoiceProvider } from "./index";
import { VapiProvider } from "./vapi";

describe("getVoiceProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to Vapi when VOICE_PROVIDER is unset", () => {
    delete process.env.VOICE_PROVIDER;
    expect(getVoiceProvider()).toBeInstanceOf(VapiProvider);
  });

  it("selects Vapi explicitly", () => {
    vi.stubEnv("VOICE_PROVIDER", "vapi");
    expect(getVoiceProvider()).toBeInstanceOf(VapiProvider);
  });

  it("throws a clear error for an unimplemented provider", () => {
    vi.stubEnv("VOICE_PROVIDER", "retell");
    expect(() => getVoiceProvider()).toThrow(
      /Unsupported VOICE_PROVIDER: retell/,
    );
  });
});
