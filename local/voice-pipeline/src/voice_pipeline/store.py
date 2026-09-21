import time
from dataclasses import dataclass, field
from typing import Literal

CallStatus = Literal["pending", "answered", "failed"]


@dataclass
class CallRecord:
    call_id: str
    question: str
    context: str | None = None
    status: CallStatus = "pending"
    answer: str | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.monotonic)

    def to_json(self) -> dict[str, str]:
        body = {"callId": self.call_id, "status": self.status}
        if self.answer is not None:
            body["answer"] = self.answer
        if self.error is not None:
            body["error"] = self.error
        return body

    @property
    def prompt(self) -> str:
        if self.context:
            return f"Context: {self.context} {self.question}"
        return self.question


class CallStore:
    """In-memory call state, keyed by call ID.

    The first terminal transition wins, so a cancellation racing a
    just-captured answer resolves consistently.
    """

    def __init__(self, ttl_s: float) -> None:
        self._ttl_s = ttl_s
        self._calls: dict[str, CallRecord] = {}

    def register(
        self, call_id: str, question: str, context: str | None
    ) -> CallRecord | None:
        """Registers a pending call, or returns `None` if the ID is taken."""
        self._prune()
        if call_id in self._calls:
            return None
        record = CallRecord(call_id, question, context)
        self._calls[call_id] = record
        return record

    def get(self, call_id: str) -> CallRecord | None:
        return self._calls.get(call_id)

    def answer(self, call_id: str, answer: str) -> bool:
        record = self._calls.get(call_id)
        if record is None or record.status != "pending":
            return False
        record.status = "answered"
        record.answer = answer
        return True

    def fail(self, call_id: str, error: str) -> bool:
        record = self._calls.get(call_id)
        if record is None or record.status != "pending":
            return False
        record.status = "failed"
        record.error = error
        return True

    def _prune(self) -> None:
        now = time.monotonic()
        expired = [
            call_id
            for call_id, record in self._calls.items()
            if now - record.created_at > self._ttl_s
        ]
        for call_id in expired:
            del self._calls[call_id]
