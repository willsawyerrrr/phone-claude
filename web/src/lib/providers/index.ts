import type { VoiceProvider } from "./types";
import { TwilioProvider } from "./twilio";

export type { VoiceProvider, StartCallParams, StartCallResult } from "./types";

export function getVoiceProvider(): VoiceProvider {
  const provider = process.env.VOICE_PROVIDER ?? "twilio";

  switch (provider) {
    case "twilio":
      return new TwilioProvider();
    default:
      throw new Error(`Unsupported VOICE_PROVIDER: ${provider}`);
  }
}
