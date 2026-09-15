import { Redis } from "@upstash/redis";

export type CallStatus = "pending" | "answered" | "failed";

export interface CallRecord {
  callId: string;
  phoneNumber: string;
  question: string;
  context?: string;
  status: CallStatus;
  answer?: string;
  error?: string;
  providerCallId?: string;
  createdAt: string;
  /**
   * How many times the question has been spoken (starts at 1). Telnyx's
   * webhook route bumps this when the caller asks to hear it again, and
   * uses it to tell a stale no-input timeout — started before the repeat —
   * apart from the current one.
   */
  promptAttempt?: number;
  /**
   * The caller's reply so far for the current promptAttempt, accumulated
   * across Telnyx transcription segments — `is_final: true` on a segment
   * means that piece of text is stable, not that the caller has finished
   * speaking. Cleared when a new promptAttempt starts.
   */
  pendingTranscript?: string;
  /**
   * Bumped on every transcription segment accumulated into
   * `pendingTranscript`. Lets a segment's own "finalize after a quiet
   * period" timer tell whether a later segment has since arrived — if so,
   * that later segment's timer owns finalizing instead.
   */
  transcriptSeq?: number;
}

const TTL_SECONDS = 60 * 60;

function key(callId: string): string {
  return `phone-claude:call:${callId}`;
}

function client(): Redis {
  // The Vercel Marketplace Upstash integration prefixes its own variable
  // names (`KV_REST_API_URL`/`KV_REST_API_TOKEN`) rather than exposing the
  // plain `UPSTASH_REDIS_REST_URL`/`_TOKEN` pair `Redis.fromEnv()` expects.
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
  });
}

export const CallStore = {
  async create(record: CallRecord): Promise<void> {
    await client().set(key(record.callId), record, { ex: TTL_SECONDS });
  },

  async get(callId: string): Promise<CallRecord | null> {
    return client().get<CallRecord>(key(callId));
  },

  /**
   * Applies `patch` to the stored record. When `options.ifStatus` is given,
   * the write is skipped — returning `null`, as if the record didn't exist —
   * unless the record's current status still matches, guarding against one
   * writer clobbering a status another writer already moved past (e.g. a
   * cancellation racing a webhook that just recorded the answer).
   */
  async update(
    callId: string,
    patch: Partial<Omit<CallRecord, "callId">>,
    options?: { ifStatus: CallStatus },
  ): Promise<CallRecord | null> {
    const existing = await CallStore.get(callId);
    if (!existing) return null;
    if (options?.ifStatus && existing.status !== options.ifStatus) return null;

    const updated: CallRecord = { ...existing, ...patch };
    await client().set(key(callId), updated, { ex: TTL_SECONDS });
    return updated;
  },
};
