import asyncio
import hmac
import logging
import uuid
from collections.abc import Callable

from aiohttp import web

from voice_pipeline.audiosocket import KIND_UUID, StreamChannel, read_frame
from voice_pipeline.config import Settings
from voice_pipeline.devices import DeviceStore, parse_device
from voice_pipeline.engines import Speaker, Transcriber, VoiceActivityDetector
from voice_pipeline.push import ApnsPusher, NoDevice, NotConfigured, PushError
from voice_pipeline.session import CallSession, Pace
from voice_pipeline.store import CallStore

log = logging.getLogger(__name__)

# How long Asterisk has to identify the call after connecting.
HANDSHAKE_TIMEOUT_S = 5.0


class Pipeline:
    """Wires the call store to the AudioSocket listener and the HTTP API."""

    def __init__(
        self,
        settings: Settings,
        vad_factory: Callable[[], VoiceActivityDetector],
        stt: Transcriber,
        tts: Speaker,
        pace: Pace = asyncio.sleep,
        devices: DeviceStore | None = None,
        pusher: ApnsPusher | None = None,
    ) -> None:
        self.settings = settings
        self.devices = devices or DeviceStore(settings.device_file)
        self.pusher = pusher or ApnsPusher(
            self.devices,
            key_id=settings.apns_key_id,
            team_id=settings.apns_team_id,
            key_file=settings.apns_key_file,
            topic=settings.apns_topic,
        )
        self.store = CallStore(settings.call_ttl_s)
        self._vad_factory = vad_factory
        self._stt = stt
        self._tts = tts
        self._pace = pace
        self._sessions: dict[str, asyncio.Task] = {}

    def cancel(self, call_id: str) -> bool:
        """Marks a pending call failed and hangs up its audio connection.

        A call that already has an outcome is left to finish."""
        cancelled = self.store.fail(call_id, "Cancelled")
        task = self._sessions.get(call_id)
        if cancelled and task is not None:
            task.cancel()
        return cancelled

    async def shutdown(self) -> None:
        """Fails every pending call and hangs up every call in progress."""
        self.store.fail_pending("The pipeline shut down")
        tasks = list(self._sessions.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.pusher.aclose()

    async def handle_audiosocket(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        channel = StreamChannel(reader, writer)
        try:
            call_id = await asyncio.wait_for(_read_call_id(reader), HANDSHAKE_TIMEOUT_S)
        except TimeoutError:
            call_id = None
        record = self.store.get(call_id) if call_id else None
        if (
            record is None
            or record.status != "pending"
            or record.call_id in self._sessions
        ):
            log.warning("rejecting audio connection for call %s", call_id)
            await channel.send_hangup()
            await channel.close()
            return

        session = CallSession(
            record,
            channel,
            self._vad_factory(),
            self._stt,
            self._tts,
            self.store,
            self.settings,
            self._pace,
        )
        self._sessions[record.call_id] = task = asyncio.current_task()
        try:
            await session.run()
        except asyncio.CancelledError:
            pass
        finally:
            if self._sessions.get(record.call_id) is task:
                del self._sessions[record.call_id]
            # Cancellation was consumed above; don't let it leak to the server.
            if task is not None:
                while task.uncancel():
                    pass

    def app(self) -> web.Application:
        app = web.Application()
        app.add_routes(
            [
                web.get("/healthz", self._healthz),
                web.post("/calls", self._register),
                web.get("/calls/{call_id}", self._status),
                web.post("/calls/{call_id}/cancel", self._cancel),
                web.post("/push", self._push),
                web.get("/device", self._device),
            ]
        )
        return app

    def device_app(self) -> web.Application:
        """The LAN-facing app, which only accepts device registration."""
        app = web.Application()
        app.add_routes([web.put("/device", self._register_device)])
        return app

    async def _push(self, _request: web.Request) -> web.Response:
        try:
            await self.pusher.send()
        except NoDevice:
            return web.json_response({"error": "No device registered"}, status=404)
        except NotConfigured:
            return web.json_response({"error": "APNs is not configured"}, status=503)
        except PushError as e:
            log.warning("push failed: %s", e.reason)
            return web.json_response({"error": e.reason}, status=502)
        return web.Response(status=204)

    async def _device(self, _request: web.Request) -> web.Response:
        device = self.devices.get()
        if device is None:
            return web.json_response({"registered": False})
        return web.json_response(
            {"registered": True, "environment": device.environment}
        )

    async def _register_device(self, request: web.Request) -> web.Response:
        secret = self.settings.device_secret
        scheme, _, presented = request.headers.get("Authorization", "").partition(" ")
        if (
            not secret
            or scheme != "Bearer"
            or not hmac.compare_digest(presented.encode(), secret.encode())
        ):
            return web.json_response({"error": "Unauthorized"}, status=401)
        try:
            body = await request.json()
            device = parse_device(body["token"], body["environment"])
        except (ValueError, KeyError, TypeError):
            return web.json_response(
                {
                    "error": "Body must be {token: hex string, "
                    "environment: sandbox|production}"
                },
                status=400,
            )
        self.devices.set(device)
        return web.Response(status=204)

    async def _healthz(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    async def _register(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            call_id = str(uuid.UUID(body["callId"]))
            question = body["question"]
            context = body.get("context")
            if not isinstance(question, str) or not question.strip():
                raise ValueError("question")
            if context is not None and not isinstance(context, str):
                raise ValueError("context")
        except (ValueError, KeyError, TypeError, AttributeError):
            return web.json_response(
                {
                    "error": "Body must be {callId: uuid, question: string, "
                    "context?: string}"
                },
                status=400,
            )
        record = self.store.register(call_id, question, context or None)
        if record is None:
            return web.json_response({"error": "callId already exists"}, status=409)
        return web.json_response(record.to_json(), status=201)

    async def _status(self, request: web.Request) -> web.Response:
        record = self.store.get(_normalise(request.match_info["call_id"]))
        if record is None:
            return web.json_response({"error": "Call not found"}, status=404)
        return web.json_response(record.to_json())

    async def _cancel(self, request: web.Request) -> web.Response:
        call_id = _normalise(request.match_info["call_id"])
        record = self.store.get(call_id)
        if record is None:
            return web.json_response({"error": "Call not found"}, status=404)
        self.cancel(call_id)
        return web.json_response(record.to_json())


async def _read_call_id(reader: asyncio.StreamReader) -> str | None:
    frame = await read_frame(reader)
    if frame is None or frame.kind != KIND_UUID or len(frame.payload) != 16:
        return None
    return str(uuid.UUID(bytes=frame.payload))


def _normalise(call_id: str) -> str:
    try:
        return str(uuid.UUID(call_id))
    except ValueError:
        return call_id
