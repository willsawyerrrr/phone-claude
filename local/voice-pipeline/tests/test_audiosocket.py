import asyncio

from voice_pipeline.audiosocket import (
    KIND_AUDIO,
    KIND_HANGUP,
    KIND_UUID,
    Frame,
    encode_frame,
    read_frame,
)


def reader_with(data: bytes) -> asyncio.StreamReader:
    reader = asyncio.StreamReader()
    reader.feed_data(data)
    reader.feed_eof()
    return reader


def test_encodes_kind_length_and_payload():
    assert encode_frame(KIND_AUDIO, b"\x01\x02") == b"\x10\x00\x02\x01\x02"
    assert encode_frame(KIND_HANGUP) == b"\x00\x00\x00"


async def test_reads_consecutive_frames():
    uuid_bytes = bytes(range(16))
    reader = reader_with(
        encode_frame(KIND_UUID, uuid_bytes) + b"\x10\x01\x40" + b"a" * 320
    )

    assert await read_frame(reader) == Frame(KIND_UUID, uuid_bytes)
    assert await read_frame(reader) == Frame(KIND_AUDIO, b"a" * 320)
    assert await read_frame(reader) is None


async def test_a_truncated_frame_reads_as_end_of_stream():
    assert await read_frame(reader_with(b"\x10\x00\x05ab")) is None
