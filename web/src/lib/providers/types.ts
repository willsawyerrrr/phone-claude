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
  /** Places an outbound call and returns the provider's identifier for it. */
  startCall(params: StartCallParams): Promise<StartCallResult>;

  /**
   * Ends an in-progress call. Resolves once the provider has accepted the
   * request; rejects if the provider refuses it (e.g. the call has already
   * ended on its side) — callers that only care the call is no longer
   * outstanding either way should treat that rejection as a no-op.
   */
  endCall(providerCallId: string): Promise<void>;
}
