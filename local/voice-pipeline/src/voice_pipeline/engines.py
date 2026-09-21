from typing import Protocol


class VoiceActivityDetector(Protocol):
    def reset(self) -> None: ...

    def is_speech(self, pcm: bytes) -> bool:
        """Whether the latest audio (8 kHz slin) contains speech."""
        ...


class Transcriber(Protocol):
    def transcribe(self, pcm: bytes) -> str:
        """Transcribes one utterance of 8 kHz slin audio."""
        ...


class Speaker(Protocol):
    def synthesize(self, text: str) -> bytes:
        """Renders `text` as 8 kHz slin audio."""
        ...
