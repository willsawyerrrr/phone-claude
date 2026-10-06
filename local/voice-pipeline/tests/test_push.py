import base64
import json

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from voice_pipeline.devices import Device, DeviceStore
from voice_pipeline.push import ApnsPusher, NoDevice, NotConfigured, PushError

TOKEN = "ab" * 32


def unb64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


class Clock:
    def __init__(self) -> None:
        self.now = 1_700_000_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def key():
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture
def key_file(tmp_path, key):
    path = tmp_path / "key.p8"
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return path


@pytest.fixture
def devices(tmp_path):
    store = DeviceStore(tmp_path / "device.json")
    store.set(Device(TOKEN, "sandbox"))
    return store


@pytest.fixture
def clock():
    return Clock()


class Apns:
    """Records requests and answers each with the scripted response."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.response = httpx.Response(200)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


@pytest.fixture
def apns():
    return Apns()


@pytest.fixture
def pusher(devices, key_file, apns, clock):
    return ApnsPusher(
        devices,
        key_id="KEY123",
        team_id="TEAM456",
        key_file=str(key_file),
        topic="dev.example.voip",
        client=httpx.AsyncClient(transport=httpx.MockTransport(apns)),
        clock=clock,
    )


async def test_sends_voip_push(pusher, apns, clock):
    await pusher.send()
    [request] = apns.requests
    assert str(request.url) == f"https://api.sandbox.push.apple.com/3/device/{TOKEN}"
    assert request.method == "POST"
    assert request.headers["apns-topic"] == "dev.example.voip"
    assert request.headers["apns-push-type"] == "voip"
    assert request.headers["apns-priority"] == "10"
    assert request.headers["apns-expiration"] == str(int(clock.now) + 30)
    assert json.loads(request.content) == {"caller": "Claude"}


async def test_production_host(pusher, devices, apns):
    devices.set(Device(TOKEN, "production"))
    await pusher.send()
    assert apns.requests[0].url.host == "api.push.apple.com"


async def test_jwt_is_es256_signed(pusher, apns, key, clock):
    await pusher.send()
    scheme, _, jwt = apns.requests[0].headers["authorization"].partition(" ")
    assert scheme == "bearer"
    header, claims, signature = jwt.split(".")
    assert json.loads(unb64(header)) == {"alg": "ES256", "kid": "KEY123"}
    assert json.loads(unb64(claims)) == {"iss": "TEAM456", "iat": int(clock.now)}
    raw = unb64(signature)
    assert len(raw) == 64
    key.public_key().verify(
        encode_dss_signature(
            int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
        ),
        f"{header}.{claims}".encode(),
        ec.ECDSA(hashes.SHA256()),
    )


async def test_jwt_cached_then_refreshed(pusher, apns, clock):
    await pusher.send()
    clock.now += 49 * 60
    await pusher.send()
    clock.now += 2 * 60
    await pusher.send()
    first, second, third = (r.headers["authorization"] for r in apns.requests)
    assert first == second != third


@pytest.mark.parametrize(
    ("status", "reason"),
    [(410, "Unregistered"), (400, "BadDeviceToken"), (410, "ExpiredToken")],
)
async def test_dead_token_is_forgotten(pusher, devices, apns, status, reason):
    apns.response = httpx.Response(status, json={"reason": reason})
    with pytest.raises(PushError) as e:
        await pusher.send()
    assert e.value.reason == reason
    assert devices.get() is None


async def test_other_rejection_keeps_device(pusher, devices, apns):
    apns.response = httpx.Response(403, json={"reason": "InvalidProviderToken"})
    with pytest.raises(PushError) as e:
        await pusher.send()
    assert e.value.reason == "InvalidProviderToken"
    assert devices.get() is not None


async def test_rejection_without_reason(pusher, apns):
    apns.response = httpx.Response(500, text="oops")
    with pytest.raises(PushError) as e:
        await pusher.send()
    assert e.value.reason == "HTTP 500"


async def test_unreachable(pusher, devices, apns):
    apns.response = httpx.ConnectError("down")
    with pytest.raises(PushError):
        await pusher.send()
    assert devices.get() is not None


async def test_no_device(pusher, devices):
    devices.clear()
    with pytest.raises(NoDevice):
        await pusher.send()


@pytest.mark.parametrize("missing", ["key_id", "team_id", "key"])
async def test_not_configured(devices, key_file, apns, missing, tmp_path):
    if missing == "key":
        key_file = tmp_path / "absent.p8"
    pusher = ApnsPusher(
        devices,
        key_id="" if missing == "key_id" else "K",
        team_id="" if missing == "team_id" else "T",
        key_file=str(key_file),
        topic="t",
        client=httpx.AsyncClient(transport=httpx.MockTransport(apns)),
    )
    with pytest.raises(NotConfigured):
        await pusher.send()
    assert not apns.requests


async def test_invalid_key_is_not_configured(devices, tmp_path, apns):
    bad = tmp_path / "bad.p8"
    bad.write_text("not a key")
    pusher = ApnsPusher(
        devices,
        key_id="K",
        team_id="T",
        key_file=str(bad),
        topic="t",
        client=httpx.AsyncClient(transport=httpx.MockTransport(apns)),
    )
    with pytest.raises(NotConfigured):
        await pusher.send()
