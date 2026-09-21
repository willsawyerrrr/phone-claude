import asyncio
import threading
import time

from tests.conftest import (
    FakeChannel,
    FakeStt,
    FakeTts,
    FakeVad,
    eventually,
    no_pace,
    quiet,
    talk,
)
from voice_pipeline.session import CallSession
from voice_pipeline.store import CallStore

CALL_ID = "8d1f4c2e-7a3b-4c55-9f0e-2b6a1d3c4e5f"


def make_session(channel, stt, settings, *, question="Ship it?", context=None):
    store = CallStore(ttl_s=60)
    record = store.register(CALL_ID, question, context)
    tts = FakeTts()
    session = CallSession(
        record, channel, FakeVad(), stt, tts, store, settings, no_pace
    )
    return session, store, tts


async def test_captures_reply_after_quiet_period(settings):
    channel = FakeChannel(talk(0.4) + quiet(1.0))
    stt = FakeStt("yes ship it")
    session, store, tts = make_session(channel, stt, settings)

    await session.run()

    assert store.get(CALL_ID).status == "answered"
    assert store.get(CALL_ID).answer == "yes ship it"
    assert tts.spoken == ["Ship it?", "Got it, thanks. Goodbye."]
    assert channel.hung_up and channel.closed


async def test_speaks_context_before_question(settings):
    channel = FakeChannel(talk(0.2) + quiet(1.0))
    session, _, tts = make_session(
        channel, FakeStt("ok"), settings, context="Tests pass."
    )

    await session.run()

    assert tts.spoken[0] == "Context: Tests pass. Ship it?"


async def test_keeps_listening_through_a_pause_shorter_than_the_quiet_period(settings):
    reply = talk(0.2) + quiet(0.3) + talk(0.2) + quiet(1.0)
    channel = FakeChannel(reply)
    stt = FakeStt("yes definitely")
    session, store, _ = make_session(channel, stt, settings)

    await session.run()

    assert len(stt.utterances) == 1
    assert store.get(CALL_ID).answer == "yes definitely"


async def test_repeat_request_speaks_the_question_again(settings):
    channel = FakeChannel(talk(0.2) + quiet(1.0), talk(0.2) + quiet(1.0))
    stt = FakeStt("can you say that again", "yes")
    session, store, tts = make_session(channel, stt, settings)

    await session.run()

    assert tts.spoken == [
        "Ship it?",
        "One more time. Ship it?",
        "Got it, thanks. Goodbye.",
    ]
    assert store.get(CALL_ID).answer == "yes"


async def test_repeat_requests_are_bounded(settings):
    turn = talk(0.2) + quiet(1.0)
    channel = FakeChannel(turn, turn, turn)
    stt = FakeStt("again", "again", "again")
    session, store, tts = make_session(channel, stt, settings)

    await session.run()

    assert tts.spoken.count("One more time. Ship it?") == settings.max_repeats
    assert store.get(CALL_ID).answer == "again"


async def test_fails_when_nothing_is_said(settings):
    channel = FakeChannel(quiet(2.0))
    session, store, tts = make_session(channel, FakeStt(), settings)

    await session.run()

    assert store.get(CALL_ID).status == "failed"
    assert store.get(CALL_ID).error == "No reply was heard"
    assert tts.spoken[-1] == "Sorry, I didn't catch that. Goodbye."
    assert channel.hung_up


async def test_fails_when_no_audio_ever_arrives(settings):
    channel = FakeChannel()
    session, store, tts = make_session(channel, FakeStt(), settings)

    async with asyncio.timeout(settings.no_input_timeout_s + 2):
        await session.run()

    assert store.get(CALL_ID).status == "failed"
    assert store.get(CALL_ID).error == "No reply was heard"
    assert tts.spoken[-1] == "Sorry, I didn't catch that. Goodbye."
    assert channel.hung_up and channel.closed


async def test_transcribes_what_was_heard_when_audio_stops_mid_reply(settings):
    channel = FakeChannel(talk(0.4))
    stt = FakeStt("yes ship it")
    session, store, _ = make_session(channel, stt, settings)

    async with asyncio.timeout(settings.quiet_period_s + 2):
        await session.run()

    assert len(stt.utterances) == 1
    assert store.get(CALL_ID).answer == "yes ship it"
    assert channel.hung_up


async def test_repeat_restarts_the_no_input_wait(settings):
    channel = FakeChannel(talk(0.2) + quiet(1.0), quiet(0.8) + talk(0.2) + quiet(1.0))
    stt = FakeStt("repeat that", "yes")
    session, store, _ = make_session(channel, stt, settings)

    await session.run()

    assert store.get(CALL_ID).answer == "yes"


async def test_unintelligible_audio_resumes_listening(settings):
    channel = FakeChannel(talk(0.2) + quiet(1.0))
    stt = FakeStt("  ")
    session, store, _ = make_session(channel, stt, settings)

    await session.run()

    assert store.get(CALL_ID).status == "failed"
    assert store.get(CALL_ID).error == "No reply was heard"


async def test_reply_is_cut_off_at_the_maximum_length(settings):
    channel = FakeChannel(talk(settings.max_reply_s + 1))
    stt = FakeStt("a very long answer")
    session, store, _ = make_session(channel, stt, settings)

    await session.run()

    assert store.get(CALL_ID).answer == "a very long answer"


async def test_caller_hanging_up_while_listening_fails_the_call(settings):
    channel = FakeChannel(talk(0.2))
    session, store, _ = make_session(channel, FakeStt(), settings)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.05)

    channel.caller_hangs_up()
    await task

    assert store.get(CALL_ID).status == "failed"
    assert store.get(CALL_ID).error == "The call ended before an answer was captured"


async def test_caller_hanging_up_while_speaking_fails_the_call(settings):
    channel = FakeChannel()
    channel.caller_hangs_up()
    session, store, _ = make_session(channel, FakeStt(), settings)

    await session.run()

    assert store.get(CALL_ID).status == "failed"


async def test_cancellation_hangs_up_the_call(settings):
    channel = FakeChannel(talk(0.2))
    session, store, _ = make_session(channel, FakeStt(), settings)
    task = asyncio.create_task(session.run())
    await asyncio.sleep(0.05)

    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert channel.hung_up and channel.closed


async def test_answer_lost_to_cancellation_is_not_recorded(settings):
    channel = FakeChannel(talk(0.2) + quiet(1.0))
    stt = FakeStt("yes")
    session, store, tts = make_session(channel, stt, settings)
    transcribe = stt.transcribe

    def transcribe_then_cancel(pcm):
        text = transcribe(pcm)
        store.fail(CALL_ID, "Cancelled")
        return text

    stt.transcribe = transcribe_then_cancel

    await session.run()

    assert store.get(CALL_ID).error == "Cancelled"
    assert "Got it, thanks. Goodbye." not in tts.spoken
    assert channel.hung_up


async def test_a_call_that_is_no_longer_pending_is_hung_up_without_speaking(settings):
    channel = FakeChannel()
    session, store, tts = make_session(channel, FakeStt(), settings)
    store.fail(CALL_ID, "Cancelled")

    await session.run()

    assert tts.spoken == []
    assert channel.hung_up


class BlockingTts(FakeTts):
    """Holds each synthesis until released, like a slow model."""

    def __init__(self):
        super().__init__()
        self.release = threading.Event()

    def synthesize(self, text):
        self.release.wait(5)
        return super().synthesize(text)


class BlockingStt(FakeStt):
    def __init__(self, *transcripts):
        super().__init__(*transcripts)
        self.started = threading.Event()
        self.release = threading.Event()

    def transcribe(self, pcm):
        self.started.set()
        self.release.wait(5)
        return super().transcribe(pcm)


async def test_sends_audio_immediately_while_the_prompt_is_synthesised(settings):
    channel = FakeChannel()
    tts = BlockingTts()
    store = CallStore(ttl_s=60)
    record = store.register(CALL_ID, "Ship it?", None)
    session = CallSession(
        record, channel, FakeVad(), FakeStt(), tts, store, settings, no_pace
    )
    task = asyncio.create_task(session.run())

    await asyncio.sleep(0.05)

    assert len(channel.sent_audio) > 3
    assert channel.speech_frames == []
    tts.release.set()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_keeps_sending_audio_while_transcribing(settings):
    channel = FakeChannel(talk(0.2) + quiet(1.0))
    stt = BlockingStt("yes")
    session, _, _ = make_session(channel, stt, settings)
    task = asyncio.create_task(session.run())
    await eventually(stt.started.is_set)

    sent = len(channel.sent_audio)
    await asyncio.sleep(0.05)

    assert len(channel.sent_audio) > sent
    stt.release.set()
    await task


async def test_audio_is_sent_in_whole_frames_at_real_time_pace(settings):
    channel = FakeChannel()
    tts = FakeTts(frames=10)
    store = CallStore(ttl_s=60)
    record = store.register(CALL_ID, "Ship it?", None)
    session = CallSession(record, channel, FakeVad(), FakeStt(), tts, store, settings)
    task = asyncio.create_task(session.run())
    started = time.monotonic()
    await eventually(lambda: len(channel.speech_frames) >= 10)
    elapsed = time.monotonic() - started

    assert elapsed >= 0.15
    assert {len(frame) for frame in channel.sent_audio} == {320}
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
