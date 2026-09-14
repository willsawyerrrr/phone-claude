import Telnyx from "telnyx";
import { NextRequest, NextResponse } from "next/server";
import { CallStore } from "@/lib/store";
import { verifyTelnyxSignature } from "@/lib/verify-telnyx-signature";

// Long enough to cover the no-input timeout below plus normal command
// round-trips.
export const maxDuration = 15;

const VOICE = "female";
const NO_INPUT_TIMEOUT_MS = 8_000;

// Tags on the `speak` commands this route issues, echoed back on the
// corresponding `call.speak.ended` webhook via `client_state`, so that
// webhook can tell the initial prompt apart from a closing message (which
// should hang up once it finishes playing).
const PROMPT_STATE = "prompt";
const GOODBYE_STATE = "goodbye";

interface TelnyxWebhookEvent {
  data?: {
    event_type?: string;
    payload?: {
      call_control_id?: string;
      client_state?: string;
      hangup_cause?: string;
      transcription_data?: {
        is_final?: boolean;
        transcript?: string;
      };
    };
  };
}

function client(): Telnyx {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: TELNYX_API_KEY");
  return new Telnyx({ apiKey });
}

function encodeState(state: string): string {
  return Buffer.from(state, "utf-8").toString("base64");
}

function decodeState(clientState: string | undefined): string | undefined {
  if (!clientState) return undefined;
  try {
    return Buffer.from(clientState, "base64").toString("utf-8");
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function speak(
  callControlId: string,
  message: string,
  state: string,
): Promise<void> {
  await client()
    .calls.actions.speak(callControlId, {
      payload: message,
      voice: VOICE,
      client_state: encodeState(state),
    })
    .catch(() => {
      // The call may already be over; nothing left to say.
    });
}

/**
 * Receives every Telnyx Call Control webhook for a call. On `call.answered`,
 * speaks the question (and context, if any); once that finishes
 * (`call.speak.ended`), starts real-time transcription and waits up to
 * `NO_INPUT_TIMEOUT_MS` for a final transcript. A `call.transcription`
 * event with a final result marks the `CallRecord` `answered`; either
 * outcome speaks a closing message tagged `GOODBYE_STATE`, and the
 * `call.speak.ended` for that message hangs up. A `call.hangup` marks the
 * record `failed` if it's still `pending` — the call ended without a
 * spoken answer.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  const { callId } = await params;
  const rawBody = await request.text();

  if (
    !publicKey ||
    !verifyTelnyxSignature(request.headers, rawBody, publicKey)
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = JSON.parse(rawBody) as TelnyxWebhookEvent;
  const eventType = event.data?.event_type;
  const payload = event.data?.payload;
  const callControlId = payload?.call_control_id;

  if (!eventType || !callControlId) {
    return NextResponse.json({ ok: true });
  }

  switch (eventType) {
    case "call.answered":
      await handleAnswered(callId, callControlId);
      break;
    case "call.speak.ended":
      await handleSpeakEnded(
        callId,
        callControlId,
        decodeState(payload?.client_state),
      );
      break;
    case "call.transcription":
      await handleTranscription(
        callId,
        callControlId,
        payload?.transcription_data,
      );
      break;
    case "call.hangup":
      await handleHangup(callId, payload?.hangup_cause);
      break;
  }

  return NextResponse.json({ ok: true });
}

async function handleAnswered(
  callId: string,
  callControlId: string,
): Promise<void> {
  const record = await CallStore.get(callId);
  if (!record) {
    await speak(
      callControlId,
      "Sorry, this call is no longer valid. Goodbye.",
      GOODBYE_STATE,
    );
    return;
  }

  const prompt = record.context
    ? `${record.question} Context: ${record.context}`
    : record.question;
  await speak(callControlId, prompt, PROMPT_STATE);
}

async function handleSpeakEnded(
  callId: string,
  callControlId: string,
  state: string | undefined,
): Promise<void> {
  if (state === PROMPT_STATE) {
    await client()
      .calls.actions.startTranscription(callControlId, {})
      .catch(() => {
        // The call may already be over; the no-input timeout below will
        // find the record already resolved and no-op.
      });
    await waitForAnswer(callId, callControlId);
    return;
  }

  if (state === GOODBYE_STATE) {
    await client()
      .calls.actions.hangup(callControlId, {})
      .catch(() => {
        // The call may already be over on Telnyx's side either way.
      });
  }
}

async function waitForAnswer(
  callId: string,
  callControlId: string,
): Promise<void> {
  await sleep(NO_INPUT_TIMEOUT_MS);

  const updated = await CallStore.update(
    callId,
    {
      status: "failed",
      error: "Call ended without a spoken answer (no input)",
    },
    { ifStatus: "pending" },
  );
  if (!updated) return; // A transcription webhook already resolved the call.

  await client()
    .calls.actions.stopTranscription(callControlId, {})
    .catch(() => {});
  await speak(
    callControlId,
    "Sorry, I didn't catch that. Goodbye.",
    GOODBYE_STATE,
  );
}

async function handleTranscription(
  callId: string,
  callControlId: string,
  transcriptionData: { is_final?: boolean; transcript?: string } | undefined,
): Promise<void> {
  if (!transcriptionData?.is_final || !transcriptionData.transcript) return;

  const updated = await CallStore.update(
    callId,
    { status: "answered", answer: transcriptionData.transcript },
    { ifStatus: "pending" },
  );
  if (!updated) return; // The no-input timeout already resolved the call.

  await client()
    .calls.actions.stopTranscription(callControlId, {})
    .catch(() => {});
  await speak(callControlId, "Got it, thanks. Goodbye.", GOODBYE_STATE);
}

async function handleHangup(
  callId: string,
  hangupCause: string | undefined,
): Promise<void> {
  const existing = await CallStore.get(callId);
  if (existing?.status === "pending") {
    await CallStore.update(callId, {
      status: "failed",
      error: `Call ended without a spoken answer (${hangupCause ?? "unknown"})`,
    });
  }
}
