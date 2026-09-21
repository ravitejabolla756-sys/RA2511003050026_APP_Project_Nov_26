"""Serve only explicitly configured local demo inputs."""
from pathlib import Path
import asyncio
import json
import threading
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
from app.core.config import get_settings
from app.services.tracking_preview import preview_manager

router = APIRouter(tags=["demo media"])
DEMO_CATALOG = (
    ("OP.mp4", "OP.mp4 · Ahmedabad demo"),
    ("vms-a.mp4", "VMS A"),
    ("vms-b.mp4", "VMS B"),
)
ALLOWED_DEMO_SOURCES = {name for name, _ in DEMO_CATALOG}


@router.get("/demo-media/catalog")
def demo_media_catalog(request: Request):
    settings = get_settings()
    if not settings.demo_mode or not settings.demo_media_dir:
        return {"items": []}
    items = []
    base_url = str(request.base_url).rstrip("/")
    for name, title in DEMO_CATALOG:
        try:
            source_path(name)
        except HTTPException:
            continue
        items.append({"name": name, "title": title,
                      "source_url": f"{base_url}/demo-media/{name}",
                      "tracks_url": f"{base_url}/demo-media/{name}/tracks"})
    return {"items": items}


@router.get("/demo-media/{name}/tracks")
def replay_tracks(name: str):
    source = source_path(name)
    cache = Path(__file__).resolve().parents[3] / '.runtime' / 'demo-replays' / Path(name).stem / 'tracks.json'
    # Read old local OP caches until the generic replay-preparation command
    # migrates them, so existing development installs remain usable.
    if name == "OP.mp4" and not cache.is_file():
        legacy = Path(__file__).resolve().parents[3] / '.runtime' / 'op-replay' / 'tracks.json'
        if legacy.is_file():
            cache = legacy
    if not cache.is_file():
        raise HTTPException(409, "Video analysis is being prepared. Original video can play normally.")
    try:
        payload = json.loads(cache.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise HTTPException(409, "Video analysis cache is invalid; regenerate the local replay.") from None
    stat = source.stat()
    if (not isinstance(payload, dict) or payload.get('source_size') != stat.st_size or
            payload.get('source_mtime_ns') != stat.st_mtime_ns or
            not isinstance(payload.get('frames'), list)):
        raise HTTPException(409, "Video changed; analysis must be regenerated.")
    return FileResponse(cache, media_type='application/json', headers={'Cache-Control':'no-store'})


def source_path(name: str) -> Path:
    settings = get_settings()
    if not settings.demo_mode or not settings.demo_media_dir or name not in ALLOWED_DEMO_SOURCES:
        raise HTTPException(404, "Demo source unavailable")
    root = Path(settings.demo_media_dir).resolve()
    path = (root / name).resolve()
    if path.parent != root or not path.is_file():
        raise HTTPException(404, "Demo file missing")
    return path


@router.get("/demo-media/{name}")
def demo_video(name: str):
    return FileResponse(source_path(name), media_type="video/mp4", headers={"X-Suraksh-Source": "LOCAL HACKATHON TEST MEDIA"})


@router.get("/demo-media/{name}/preview")
def recorded_preview(name: str, annotations: bool = Query(True), track_ids: bool = Query(True)):
    path = source_path(name)
    worker = preview_manager.worker(path, name)

    async def frames():
        try:
            last_version = -1
            while True:
                data, version, snapshot = await run_in_threadpool(worker.latest, annotations, track_ids)
                if data is not None and version != last_version:
                    last_version = version
                    yield (f"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(data)}\r\nX-Frame-Index: {snapshot['frame']}\r\n\r\n".encode() + data + b"\r\n")
                await asyncio.sleep(0.04)
        finally:
            pass

    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-store", "X-Suraksh-Source": "DEMO RECORDED CCTV SOURCE"})


@router.get("/demo-media/{name}/runtime")
def recorded_runtime(name: str):
    path = source_path(name)
    worker = preview_manager.worker(path, name)
    return worker.latest()[2]
