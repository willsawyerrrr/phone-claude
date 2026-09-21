"""Asterisk AudioSocket wire protocol.

Each frame is a 1-byte kind, a 2-byte big-endian payload length, and the
payload. Audio is 8 kHz, 16-bit signed linear PCM, mono.
"""

import asyncio
from dataclasses import dataclass
from typing import Protocol

KIND_HANGUP = 0x00
KIND_UUID = 0x01
KIND_DTMF = 0x03
KIND_AUDIO = 0x10
KIND_ERROR = 0xFF


@dataclass(frozen=True)
class Frame:
    kind: int
    payload: bytes = b""


def encode_frame(kind: int, payload: bytes = b"") -> bytes:
    return bytes([kind]) + len(payload).to_bytes(2, "big") + payload


async def read_frame(reader: asyncio.StreamReader) -> Frame | None:
    """Reads one frame, or returns `None` once the peer closes the stream."""
    try:
        header = await reader.readexactly(3)
        payload = await reader.readexactly(int.from_bytes(header[1:], "big"))
    except (asyncio.IncompleteReadError, ConnectionError):
        return None
    return Frame(header[0], payload)


class Channel(Protocol):
    """One call's audio connection to Asterisk."""

    async def recv(self) -> Frame | None: ...

    async def send_audio(self, pcm: bytes) -> None: ...

    async def send_hangup(self) -> None: ...

    async def close(self) -> None: ...


class StreamChannel:
    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._reader = reader
        self._writer = writer

    async def recv(self) -> Frame | None:
        return await read_frame(self._reader)

    async def send_audio(self, pcm: bytes) -> None:
        await self._send(encode_frame(KIND_AUDIO, pcm))

    async def send_hangup(self) -> None:
        await self._send(encode_frame(KIND_HANGUP))

    async def close(self) -> None:
        self._writer.close()
        try:
            await self._writer.wait_closed()
        except ConnectionError:
            pass

    async def _send(self, data: bytes) -> None:
        try:
            self._writer.write(data)
            await self._writer.drain()
        except ConnectionError:
            pass
