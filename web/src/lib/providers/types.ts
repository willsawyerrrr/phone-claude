export interface StartCallParams {
  callId: string;
  phoneNumber: string;
  question: string;
  context?: string;
}

export interface StartCallResult {
  providerCallId: string;
}

/**
 * Seam between the call API and a specific voice platform. Implement this
 * for each platform (Twilio, Retell, Bland, ...) so `web/src/lib/providers/index.ts`
 * can select one via the `VOICE_PROVIDER` env var without the rest of the
 * app knowing which platform is in use.
 */
export interface VoiceProvider {
  startCall(params: StartCallParams): Promise<StartCallResult>;
}
