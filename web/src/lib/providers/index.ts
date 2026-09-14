import type { VoiceProvider } from "./types";
import { TwilioProvider } from "./twilio";
import { TelnyxProvider } from "./telnyx";

export type { VoiceProvider, StartCallParams, StartCallResult } from "./types";

export function getVoiceProvider(): VoiceProvider {
  const provider = process.env.VOICE_PROVIDER ?? "twilio";

  switch (provider) {
    case "twilio":
      return new TwilioProvider();
    case "telnyx":
      return new TelnyxProvider();
    default:
      throw new Error(`Unsupported VOICE_PROVIDER: ${provider}`);
  }
}
