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
}

const TTL_SECONDS = 60 * 60;

function key(callId: string): string {
  return `phone-claude:call:${callId}`;
}

function client(): Redis {
  return Redis.fromEnv();
}

export const CallStore = {
  async create(record: CallRecord): Promise<void> {
    await client().set(key(record.callId), record, { ex: TTL_SECONDS });
  },

  async get(callId: string): Promise<CallRecord | null> {
    return client().get<CallRecord>(key(callId));
  },

  async update(
    callId: string,
    patch: Partial<Omit<CallRecord, "callId">>,
  ): Promise<CallRecord | null> {
    const existing = await CallStore.get(callId);
    if (!existing) return null;

    const updated: CallRecord = { ...existing, ...patch };
    await client().set(key(callId), updated, { ex: TTL_SECONDS });
    return updated;
  },
};
