import { describe, expect, it } from "vitest";

import { buildSegments, shuffled } from "./audition.js";

describe("buildSegments", () => {
  it("reads each prompt in every voice, numbering the voices", () => {
    expect(
      buildSegments(["Ship it?"], ["alba-casual", "alba-announcer"]),
    ).toEqual([
      { text: "Voice one." },
      { text: "Ship it?", voice: "alba-casual" },
      { text: "Voice two." },
      { text: "Ship it?", voice: "alba-announcer" },
      { text: "That was all of them. Which voice did you like best?" },
    ]);
  });

  it("keeps the voice order for every prompt", () => {
    const segments = buildSegments(["One?", "Two?"], ["a", "b"]);

    expect(segments.filter((s) => s.voice).map((s) => s.voice)).toEqual([
      "a",
      "b",
      "a",
      "b",
    ]);
  });
});

describe("shuffled", () => {
  it("returns every item without changing the input", () => {
    const items = [1, 2, 3, 4, 5];

    const result = shuffled(items, () => 0.3);

    expect([...result].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});
