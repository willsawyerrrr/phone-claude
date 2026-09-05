import { describe, expect, it, vi, beforeEach } from "vitest";

const redisStore = new Map<string, unknown>();

vi.mock("@upstash/redis", () => ({
  Redis: class {
    set = vi.fn(async (key: string, value: unknown) => {
      redisStore.set(key, value);
    });
    get = vi.fn(async (key: string) => redisStore.get(key) ?? null);
  },
}));

const { CallStore } = await import("./store");

describe("CallStore", () => {
  beforeEach(() => {
    redisStore.clear();
  });

  it("creates a pending record and reads it back", async () => {
    await CallStore.create({
      callId: "call-1",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const record = await CallStore.get("call-1");
    expect(record?.status).toBe("pending");
  });

  it("transitions a record to answered", async () => {
    await CallStore.create({
      callId: "call-2",
      phoneNumber: "+10000000000",
      question: "Deploy now?",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const updated = await CallStore.update("call-2", {
      status: "answered",
      answer: "Yes",
    });

    expect(updated?.status).toBe("answered");
    expect(updated?.answer).toBe("Yes");
  });

  it("returns null when updating a record that doesn't exist", async () => {
    const updated = await CallStore.update("missing", { status: "failed" });
    expect(updated).toBeNull();
  });
});
