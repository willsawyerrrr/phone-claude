import base64
import json
import time
from pathlib import Path

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from voice_pipeline.devices import Device, DeviceStore

HOSTS = {
    "production": "https://api.push.apple.com",
    "sandbox": "https://api.sandbox.push.apple.com",
}
TOKEN_TTL_S = 50 * 60
EXPIRATION_S = 30
# Reasons meaning the token will never work again.
DEAD_TOKEN_REASONS = {"BadDeviceToken", "Unregistered"}


class PushError(Exception):
    """APNs rejected the push or couldn't be reached; `reason` says why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class NoDevice(Exception):
    """No device is registered."""


class NotConfigured(Exception):
    """The APNs key, key id or team id is missing."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class ApnsPusher:
    """Sends VoIP pushes to the registered device over APNs HTTP/2."""

    def __init__(
        self,
        devices: DeviceStore,
        *,
        key_id: str,
        team_id: str,
        key_file: str,
        topic: str,
        client: httpx.AsyncClient | None = None,
        clock=time.time,
    ) -> None:
        self._devices = devices
        self._key_id = key_id
        self._team_id = team_id
        self._key_file = Path(key_file)
        self._topic = topic
        self._client = client or httpx.AsyncClient(http2=True, timeout=10.0)
        self._clock = clock
        self._jwt: tuple[str, float] | None = None

    def _key_pem(self) -> bytes:
        try:
            return self._key_file.read_bytes().strip()
        except OSError:
            return b""

    def _bearer(self) -> str:
        now = self._clock()
        if self._jwt and now - self._jwt[1] < TOKEN_TTL_S:
            return self._jwt[0]
        pem = self._key_pem()
        if not (self._key_id and self._team_id and pem):
            raise NotConfigured
        try:
            key = serialization.load_pem_private_key(pem, password=None)
            if not isinstance(key, ec.EllipticCurvePrivateKey):
                raise ValueError
        except ValueError as e:
            raise NotConfigured from e
        header = {"alg": "ES256", "kid": self._key_id}
        claims = {"iss": self._team_id, "iat": int(now)}
        signing_input = ".".join(
            _b64(json.dumps(part, separators=(",", ":")).encode())
            for part in (header, claims)
        )
        r, s = decode_dss_signature(
            key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256()))
        )
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        token = f"{signing_input}.{_b64(signature)}"
        self._jwt = (token, now)
        return token

    async def send(self) -> None:
        """Pushes a call to the registered device.

        Raises `NoDevice`, `NotConfigured` or `PushError`. Forgets the device
        when APNs says its token is dead."""
        device: Device | None = self._devices.get()
        if device is None:
            raise NoDevice
        bearer = self._bearer()
        try:
            response = await self._client.post(
                f"{HOSTS[device.environment]}/3/device/{device.token}",
                headers={
                    "authorization": f"bearer {bearer}",
                    "apns-topic": self._topic,
                    "apns-push-type": "voip",
                    "apns-priority": "10",
                    "apns-expiration": str(int(self._clock()) + EXPIRATION_S),
                },
                json={"caller": "Claude"},
            )
        except httpx.HTTPError as e:
            raise PushError("APNs is unreachable") from e
        if response.is_success:
            return
        try:
            reason = str(response.json()["reason"])
        except (ValueError, KeyError, TypeError):
            reason = f"HTTP {response.status_code}"
        if response.status_code == 410 or reason in DEAD_TOKEN_REASONS:
            self._devices.clear(device.token)
        if reason == "ExpiredProviderToken":
            self._jwt = None
        raise PushError(reason)

    async def aclose(self) -> None:
        await self._client.aclose()
