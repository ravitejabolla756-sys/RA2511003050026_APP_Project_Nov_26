"""Allowlisted public camera preview through SURAKSH's local tracker."""
import asyncio

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.services.tracking_preview import preview_manager

router = APIRouter(tags=["public camera preview"])
CAMERA_KEY = "public-iowa-i680"


def _worker():
    settings = get_settings()
    if not settings.demo_mode:
        raise HTTPException(404, "Public demo camera is disabled")
    return preview_manager.worker(settings.public_live_camera_source_url, CAMERA_KEY, live=True)


@router.get("/public-live-camera/preview")
def live_camera_preview(annotations: bool = Query(True), track_ids: bool = Query(True)):
    worker = _worker()

    async def frames():
        last_version = -1
        while True:
            data, version, snapshot = await run_in_threadpool(worker.latest, annotations, track_ids)
            if data is not None and version != last_version:
                last_version = version
                yield (f"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(data)}\r\n"
                       f"X-Frame-Index: {snapshot['frame']}\r\n\r\n".encode() + data + b"\r\n")
            await asyncio.sleep(0.04)

    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-store", "X-Suraksh-Source": "PUBLIC IOWA DOT LIVE CAMERA"})


@router.get("/public-live-camera/runtime")
def live_camera_runtime():
    return _worker().latest()[2]
