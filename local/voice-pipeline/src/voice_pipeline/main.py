import asyncio
import logging
from pathlib import Path

from aiohttp import web

from voice_pipeline.config import Settings
from voice_pipeline.models import PiperSpeaker, SileroVad, WhisperTranscriber
from voice_pipeline.server import Pipeline


async def serve(settings: Settings) -> None:
    models = Path(settings.models_dir)
    vad_path = models / "silero_vad.onnx"
    pipeline = Pipeline(
        settings,
        lambda: SileroVad.load(vad_path, settings.vad_threshold),
        WhisperTranscriber(models / settings.whisper_model),
        PiperSpeaker(models / f"{settings.piper_voice}.onnx"),
    )

    audiosocket = await asyncio.start_server(
        pipeline.handle_audiosocket, "0.0.0.0", settings.audiosocket_port
    )
    runner = web.AppRunner(pipeline.app(), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", settings.http_port).start()
    logging.getLogger(__name__).info(
        "listening: audiosocket %d, http %d",
        settings.audiosocket_port,
        settings.http_port,
    )
    async with audiosocket:
        await audiosocket.serve_forever()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    asyncio.run(serve(Settings.from_env()))
