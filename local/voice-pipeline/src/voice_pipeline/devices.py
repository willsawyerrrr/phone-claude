import contextlib
import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

log = logging.getLogger(__name__)

Environment = Literal["sandbox", "production"]
ENVIRONMENTS: tuple[Environment, ...] = ("sandbox", "production")
_HEX = re.compile(r"[0-9a-fA-F]+")


@dataclass(frozen=True)
class Device:
    token: str
    environment: Environment


def parse_device(token: object, environment: object) -> Device:
    """Validates a push token and environment, lower-casing the token.

    Raises `ValueError` if either is invalid."""
    if (
        not isinstance(token, str)
        or not 32 <= len(token) <= 200
        or len(token) % 2
        or not _HEX.fullmatch(token)
    ):
        raise ValueError("token")
    if environment not in ENVIRONMENTS:
        raise ValueError("environment")
    return Device(token.lower(), environment)


class DeviceStore:
    """Persists the one registered device as JSON, surviving restarts."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self._path = Path(path)
        self._device = self._load()

    def _load(self) -> Device | None:
        try:
            data = json.loads(self._path.read_text())
            return parse_device(data["token"], data["environment"])
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError, TypeError):
            log.warning("ignoring unreadable device file %s", self._path)
            return None

    def get(self) -> Device | None:
        return self._device

    def set(self, device: Device) -> None:
        """Persists atomically via a temp file and rename."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump({"token": device.token, "environment": device.environment}, f)
            os.replace(tmp, self._path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
        self._device = device

    def clear(self, token: str | None = None) -> None:
        """Forgets the device, if `token` is given only when it matches."""
        if self._device is None or token not in (None, self._device.token):
            return
        self._device = None
        with contextlib.suppress(FileNotFoundError):
            self._path.unlink()
