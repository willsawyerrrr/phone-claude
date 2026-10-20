import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import {
  cancelCall,
  pollForAnswer,
  startCall,
  type Segment,
} from "./client.js";
import { loadConfig } from "./config.js";

interface AuditionOffer {
  default: string;
  candidates: string[];
  prompts: Record<string, string>;
}

const DEFAULT_PROMPTS = ["context", "technical"];
const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/**
 * The script for a blind comparison: each prompt is read once per voice, in
 * the same order every time, each reading introduced by its voice's number.
 */
export function buildSegments(prompts: string[], voices: string[]): Segment[] {
  const segments: Segment[] = [];
  for (const text of prompts) {
    voices.forEach((voice, index) => {
      segments.push({ text: `Voice ${NUMBER_WORDS[index] ?? index + 1}.` });
      segments.push({ text, voice });
    });
  }
  segments.push({
    text: "That was all of them. Which voice did you like best?",
  });
  return segments;
}

export function shuffled<T>(items: T[], random = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      prompts: { type: "string" },
      voices: { type: "string" },
      "no-shuffle": { type: "boolean" },
    },
  });
  const config = loadConfig();

  const response = await fetch(`${config.pipelineUrl}/audition`);
  if (!response.ok) throw new Error(`Pipeline returned ${response.status}`);
  const offer = (await response.json()) as AuditionOffer;

  const promptIds = values.prompts
    ? values.prompts === "all"
      ? Object.keys(offer.prompts)
      : values.prompts.split(",")
    : DEFAULT_PROMPTS;
  const prompts = promptIds.map((id) => {
    const text = offer.prompts[id];
    if (!text) {
      throw new Error(
        `Unknown prompt ${id}; choose from ${Object.keys(offer.prompts).join(", ")}, all`,
      );
    }
    return text;
  });
  const candidates = values.voices
    ? values.voices.split(",")
    : offer.candidates;
  const voices = values["no-shuffle"] ? candidates : shuffled(candidates);

  const callId = randomUUID();
  const abort = () => {
    void cancelCall(config, callId).finally(() => process.exit(130));
  };
  process.once("SIGINT", abort);

  console.log(
    `Calling with ${voices.length} voices x ${prompts.length} prompts. ` +
      "Say 'repeat' to hear it again, or just say which voice you liked to end.",
  );
  await startCall(
    config,
    callId,
    "Voice audition",
    undefined,
    buildSegments(prompts, voices),
  );
  const answer = await pollForAnswer(config, callId);

  console.log(`\nYou said: ${answer}\n`);
  voices.forEach((voice, index) => {
    console.log(`Voice ${NUMBER_WORDS[index] ?? index + 1}: ${voice}`);
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
