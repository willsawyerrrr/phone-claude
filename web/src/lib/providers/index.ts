import type { VoiceProvider } from "./types";
import { VapiProvider } from "./vapi";

export type { VoiceProvider, StartCallParams, StartCallResult } from "./types";

export function getVoiceProvider(): VoiceProvider {
  const provider = process.env.VOICE_PROVIDER ?? "vapi";

  switch (provider) {
    case "vapi":
      return new VapiProvider();
    default:
      throw new Error(`Unsupported VOICE_PROVIDER: ${provider}`);
  }
}
