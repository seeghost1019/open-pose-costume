"""OpenAI-compatible image edit API in front of the Qwen-Image 2.1 Gradio WebUI.

The Open Pose & Costume site sends `POST /v1/images/edits` as multipart form data
(`model`, `prompt`, `n`, `size`, `quality`, `image[]`) with `Authorization: Bearer <key>`
and reads `{"data": [{"b64_json": ...}]}` or `{"error": {"message": ...}}` back.

This adapter forwards each request to the WebUI's `/multi` endpoint with gradio_client,
so the Gradio username and password stay on the server and never reach the browser.

Cloudflare closes proxied requests that send nothing for 100 seconds, so the response
starts at once and sends a space every few seconds until the image is ready. JSON allows
leading whitespace, and the site treats a body with an `error` field as a failure even
when the status is 200.

Colab usage (after the Gradio WebUI is running on 127.0.0.1:7860):

    from opc_image_adapter import Settings, create_app, gradio_backend, serve
    backend = gradio_backend("http://127.0.0.1:7860", (WEBUI_USER, WEBUI_PASS), steps=10)
    serve(create_app(backend, Settings(api_key=OPC_API_KEY)), port=8000)
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import io
import json
import os
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image, UnidentifiedImageError
from starlette.datastructures import UploadFile

# Site "畫面尺寸" option -> WebUI `size` (aspect ratio; the WebUI picks the 2K pixels).
SITE_SIZES = {
    "1024x1024": "1:1",
    "2048x2048": "1:1",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
    "auto": "auto",
}
# Site "品質" option -> WebUI `steps` (10–60), unless gradio_backend(steps=...) fixes it.
QUALITY_STEPS = {"low": 20, "medium": 30, "high": 40, "auto": 40}
MIN_IMAGES, MAX_IMAGES = 2, 10  # The WebUI's /multi accepts 2–10 references.
MAX_IMAGE_BYTES = 20 * 1024 * 1024  # Matches the WebUI's max_file_size="20mb".
MAX_PROMPT_CHARS = 8000
FORMATS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}

# (prompt, reference image paths, WebUI size, steps) -> encoded image bytes
Backend = Callable[[str, list[str], str, int], bytes]


@dataclass
class Settings:
    api_key: str
    allowed_origins: list[str] = field(
        default_factory=lambda: [
            "https://seeghost1019.github.io",
            "http://localhost:5199",
            "http://127.0.0.1:5199",
        ]
    )
    keepalive_seconds: float = 10.0


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def gradio_backend(
    url: str,
    auth: tuple[str, str],
    output_resolution: int = 1328,
    seed: int = -1,
    steps: int | None = None,
) -> Backend:
    """Call the WebUI's /multi endpoint; arguments are positional, in the WebUI's order.

    `steps` fixes the step count for every request instead of following the site's quality
    option. Use it with the Turbo weights: their saved 8-step schedule applies regardless of
    `num_inference_steps`, so pass the WebUI's minimum (10) rather than 8, which it rejects
    unless its steps slider allows 8.
    """
    if steps is not None and not 1 <= steps <= 60:
        raise ValueError("steps must be between 1 and 60.")
    from gradio_client import Client, handle_file

    state: dict = {}

    def client():
        if "client" not in state:
            state["client"] = Client(url, auth=auth, verbose=False)
        return state["client"]

    fixed_steps = steps

    def run(prompt: str, paths: list[str], size: str, steps: int) -> bytes:
        files = [{"image": handle_file(path), "caption": None} for path in paths]
        arguments = (files, prompt, fixed_steps or steps, seed, False, 1.0, output_resolution, size, 2048, 2048, False)
        try:
            result = client().predict(*arguments, api_name="/multi")
        except Exception as error:
            # Reconnect once when the WebUI restarted; WebUI validation errors (gr.Error) recur and surface.
            if type(error).__name__ == "AppError":
                raise
            state.pop("client", None)
            result = client().predict(*arguments, api_name="/multi")
        _preview, original, _info = result
        path = original if isinstance(original, str) else (original or {}).get("path")
        if not path:
            path = _preview if isinstance(_preview, str) else (_preview or {}).get("path")
        with open(path, "rb") as file:
            return file.read()

    return run


def _authorized(request: Request, api_key: str) -> bool:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    return bool(api_key) and scheme.lower() == "bearer" and hmac.compare_digest(token.strip(), api_key)


async def _save_images(files: list[UploadFile], folder: str) -> list[str]:
    if len(files) < MIN_IMAGES:
        raise ApiError(400, f"At least {MIN_IMAGES} reference images are required.")
    if len(files) > MAX_IMAGES:
        raise ApiError(400, f"At most {MAX_IMAGES} reference images are supported.")
    paths = []
    for index, upload in enumerate(files):
        data = await upload.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            raise ApiError(413, "Each reference image must be 20 MB or smaller.")
        try:
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
                kind = image.format
        except (UnidentifiedImageError, OSError):
            kind = None
        if kind not in FORMATS:
            raise ApiError(400, "Reference images must be PNG, JPEG or WebP.")
        path = os.path.join(folder, f"reference-{index + 1}{FORMATS[kind]}")
        with open(path, "wb") as file:
            file.write(data)
        paths.append(path)
    return paths


def _result_payload(data: bytes) -> dict:
    if not (data.startswith(b"\x89PNG") or data.startswith(b"\xff\xd8\xff") or data[8:12] == b"WEBP"):
        raise RuntimeError("The WebUI did not return a PNG, JPEG or WebP image.")
    return {"created": int(time.time()), "data": [{"b64_json": base64.b64encode(data).decode("ascii")}]}


def _error_message(error: Exception) -> str:
    text = str(error).strip() or type(error).__name__
    return f"Generation failed: {text}"[:300]


def create_app(backend: Backend, settings: Settings) -> FastAPI:
    if not settings.api_key:
        raise ValueError("Set an API key before starting the adapter.")
    app = FastAPI(title="Open Pose & Costume image adapter", docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.post("/v1/images/edits")
    async def edits(request: Request):
        folder = tempfile.mkdtemp(prefix="opc-")
        try:
            if not _authorized(request, settings.api_key):
                raise ApiError(401, "Invalid API key.")
            form = await request.form()
            prompt = str(form.get("prompt") or "").strip()
            if not prompt:
                raise ApiError(400, "prompt is required.")
            if len(prompt) > MAX_PROMPT_CHARS:
                raise ApiError(400, f"prompt must be at most {MAX_PROMPT_CHARS} characters.")
            if str(form.get("n") or "1") != "1":
                raise ApiError(400, "Only n=1 is supported.")
            size = str(form.get("size") or "auto")
            if size not in SITE_SIZES:
                raise ApiError(400, f"Unsupported size: {size}")
            quality = str(form.get("quality") or "auto")
            if quality not in QUALITY_STEPS:
                raise ApiError(400, f"Unsupported quality: {quality}")
            files = [
                item
                for item in form.getlist("image[]") + form.getlist("image")
                if isinstance(item, UploadFile)
            ]
            paths = await _save_images(files, folder)
        except ApiError as error:
            shutil.rmtree(folder, ignore_errors=True)
            return JSONResponse({"error": {"message": error.message}}, status_code=error.status)

        def run() -> dict:
            started = time.time()
            data = backend(prompt, paths, SITE_SIZES[size], QUALITY_STEPS[quality])
            print(f"Generated {SITE_SIZES[size]} from {len(paths)} references in {time.time() - started:.1f}s")
            return _result_payload(data)

        async def stream():
            task = asyncio.create_task(asyncio.to_thread(run))
            try:
                while True:
                    done, _ = await asyncio.wait({task}, timeout=settings.keepalive_seconds)
                    if done:
                        break
                    yield b" "
                try:
                    payload = task.result()
                except Exception as error:  # The status is already sent, so report failures in the body.
                    print(f"Generation failed: {error!r}")
                    payload = {"error": {"message": _error_message(error)}}
                yield json.dumps(payload, ensure_ascii=False).encode()
            finally:
                shutil.rmtree(folder, ignore_errors=True)

        return StreamingResponse(stream(), media_type="application/json")

    return app


def serve(app: FastAPI, port: int = 8000):
    """Run uvicorn in a background thread so the Colab cell returns."""
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.1)
    print(f"Adapter listening on http://127.0.0.1:{port}")
    return server
